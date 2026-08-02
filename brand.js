/**
 * lokLiquid — ad renderer
 *
 * The client-facing pipeline: track + brand + template -> finished spot.
 *
 * Two rendering paths, chosen honestly rather than pretending one covers both:
 *
 *   OFFLINE (preferred, deterministic)
 *     The track is decoded once with OfflineAudioContext and its beat/energy
 *     timeline extracted as plain data. That timeline then drives the fluid
 *     through the normal fixed-timestep stepFrame() loop, so the render is
 *     reproducible, faster than realtime, and identical on every device.
 *     This is what closes the determinism gap the live audio mode has.
 *
 *   LIVE (fallback)
 *     If decoding fails (some codecs/DRM/CORS cases), fall back to capturing
 *     the canvas in real time while the track plays.
 *
 * Audio is muxed only in the live path — MediaRecorder can capture an audio
 * track alongside canvas. The offline path produces silent video, and the UI
 * must say so, because a silent "finished ad" that surprises a client is
 * worse than one that was labelled.
 */
import { composite, SHARE_PRESETS, canvasToBlob } from './capture.js';
import { pickMimeType, videoSupported } from './video.js';

// ---------------------------------------------------------------------------
// offline audio analysis -> plain timeline data
// ---------------------------------------------------------------------------
/**
 * Decode a track and extract a per-frame band/beat timeline.
 * @returns {{fps:number, frames:Array<{bass:number,mid:number,treble:number,beat:boolean}>, bpm:number, duration:number}}
 */
export async function analyzeTrack(arrayBuffer, { fps = 60, maxSeconds = 60 } = {}) {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Off) throw new Error('This browser cannot analyze audio offline.');

  // decode with a throwaway context (decodeAudioData needs any context)
  const probe = new Off(1, 1, 44100);
  const buffer = await probe.decodeAudioData(arrayBuffer.slice(0));
  const duration = Math.min(buffer.duration, maxSeconds);
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);

  const frameCount = Math.floor(duration * fps);
  const hop = Math.floor(sr / fps);
  const win = Math.min(2048, hop * 2);

  // three band energies per frame via simple time-domain filtering:
  // cheap one-pole low/high pass, which is plenty for driving visuals and
  // avoids shipping an FFT for something nobody will look at numerically.
  const frames = [];
  let lpState = 0, hpState = 0, prevSample = 0;
  const lpCoef = 0.06, hpCoef = 0.65;

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let bassE = 0, trebleE = 0, allE = 0, n = 0;
    for (let i = start; i < Math.min(start + win, ch.length); i++) {
      const s = ch[i];
      lpState += lpCoef * (s - lpState);                       // low-pass -> kick
      hpState = hpCoef * (hpState + s - prevSample);           // high-pass -> hats
      prevSample = s;
      bassE += lpState * lpState;
      trebleE += hpState * hpState;
      allE += s * s;
      n++;
    }
    n = Math.max(1, n);
    const bass = Math.sqrt(bassE / n);
    const treble = Math.sqrt(trebleE / n);
    const overall = Math.sqrt(allE / n);
    frames.push({ bass, treble, mid: Math.max(0, overall - bass - treble), overall, beat: false });
  }

  // normalize each band to 0..1 against its own 95th percentile so quiet
  // masters and loud masters both drive the visuals fully
  for (const key of ['bass', 'mid', 'treble', 'overall']) {
    const sorted = frames.map(f => f[key]).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    for (const f of frames) f[key] = Math.min(1, f[key] / (p95 || 1));
  }

  // beat flags: bass spike vs. rolling local mean
  const hist = [];
  const HIST = Math.round(fps * 0.9);
  let lastBeatFrame = -99;
  const minGap = Math.round(fps * 0.2);
  frames.forEach((fr, i) => {
    hist.push(fr.bass);
    if (hist.length > HIST) hist.shift();
    const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
    if (fr.bass > mean * 1.3 && fr.bass > 0.18 && (i - lastBeatFrame) > minGap) {
      fr.beat = true;
      lastBeatFrame = i;
    }
  });

  // BPM from median inter-beat interval
  const beatFrames = frames.map((f, i) => f.beat ? i : -1).filter(i => i >= 0);
  let bpm = 120;
  if (beatFrames.length > 4) {
    const gaps = [];
    for (let i = 1; i < beatFrames.length; i++) gaps.push(beatFrames[i] - beatFrames[i-1]);
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    if (med > 0) {
      bpm = Math.round((60 * fps) / med);
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      bpm = Math.round(bpm);
    }
  }

  return { fps, frames, bpm, duration };
}

// ---------------------------------------------------------------------------
export class AdRenderer {
  constructor(fluid, objectLayer, brand, composer) {
    this.fluid = fluid;
    this.objects = objectLayer;
    this.brand = brand;
    this.composer = composer;
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  /**
   * Deterministic offline render. Silent video — audio is not muxed here.
   * @returns {Promise<{blob:Blob, ext:string, silent:boolean, frames:number}>}
   */
  async renderOffline({ timeline, preset = 'instagram-story', fps = 30, onProgress } = {}) {
    if (!videoSupported()) throw new Error('This browser cannot record video.');
    const mime = pickMimeType();
    if (!mime) throw new Error('No supported video codec.');

    const spec = SHARE_PRESETS[preset] || SHARE_PRESETS.square;
    const f = this.fluid;
    const wasRunning = f._running;
    const snap = { frame: f.frame, time: f.time };
    f.stop();
    this.cancelled = false;

    const out = document.createElement('canvas');
    out.width = spec.w; out.height = spec.h;
    const octx = out.getContext('2d');

    const stream = out.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 14e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(res => { rec.onstop = res; });
    rec.start();

    const duration = this.composer.duration;
    const total = Math.round(duration * fps);
    const srcRatio = timeline ? timeline.fps / fps : 1;

    f.reset();

    for (let i = 0; i < total && !this.cancelled; i++) {
      const t = i / fps;

      // drive the sim from the pre-extracted timeline — no live audio clock,
      // so this is fully reproducible
      if (timeline) {
        const idx = Math.min(timeline.frames.length - 1, Math.floor(i * srcRatio));
        const fr = timeline.frames[idx];
        f.config.curl = 14 + fr.overall * 60;
        f.config.velocityDissipation = 0.35 - fr.treble * 0.15;
        if (fr.beat) {
          const r = f.rng;
          const n = 1 + Math.round(fr.bass * 2);
          for (let k = 0; k < n; k++) {
            const a = r() * Math.PI * 2;
            const mag = 2500 + fr.bass * 6000;
            f.splat(r(), r(), Math.cos(a) * mag, Math.sin(a) * mag);
          }
        }
        f._ambientAcc = (f._ambientAcc || 0) + fr.overall * 0.3;
      }

      const steps = Math.max(1, Math.round(f.config.fps / fps));
      for (let s = 0; s < steps; s++) f.stepFrame();

      const objCanvas = this.objects
        ? this.objects.renderDisplay(f.canvas.width, f.canvas.height) : null;
      const merged = composite(f.canvas, objCanvas, spec.w, spec.h, this.brand.background);
      octx.clearRect(0, 0, spec.w, spec.h);
      octx.drawImage(merged, 0, 0);
      await this.composer.draw(octx, spec.w, spec.h, t);

      if (track.requestFrame) track.requestFrame();
      else if (stream.requestFrame) stream.requestFrame();
      if (onProgress) onProgress((i + 1) / total);
      await new Promise(r => setTimeout(r, 0));
    }

    rec.stop();
    await done;
    track.stop();

    f.reset();
    for (let i = 0; i < snap.frame; i++) f._step(1 / f.config.fps);
    f.frame = snap.frame; f.time = snap.time;
    f.render();
    if (wasRunning) f.start();

    const blob = new Blob(chunks, { type: mime });
    return { blob, ext: mime.includes('mp4') ? 'mp4' : 'webm', silent: true, frames: total };
  }

  /**
   * Live render WITH audio muxed in. Real-time, not reproducible, but the
   * output has sound — which is what a client actually wants to post.
   */
  async renderLiveWithAudio({ audioEl, preset = 'instagram-story', fps = 30, onProgress } = {}) {
    if (!videoSupported()) throw new Error('This browser cannot record video.');
    const mime = pickMimeType();
    if (!mime) throw new Error('No supported video codec.');
    const spec = SHARE_PRESETS[preset] || SHARE_PRESETS.square;

    const out = document.createElement('canvas');
    out.width = spec.w; out.height = spec.h;
    const octx = out.getContext('2d');

    const canvasStream = out.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks()];

    // pull an audio track off the playing element so the export has sound
    let audioCtx = null;
    try {
      if (audioEl) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaElementSource(audioEl);
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(dest);
        src.connect(audioCtx.destination);      // keep it audible while recording
        tracks.push(...dest.stream.getAudioTracks());
      }
    } catch {
      // an element can only have one MediaElementSource; if the live driver
      // already claimed it, we record silent rather than failing the export
    }

    const mixed = new MediaStream(tracks);
    const rec = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 14e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(res => { rec.onstop = res; });

    this.cancelled = false;
    const duration = this.composer.duration;
    if (audioEl) { audioEl.currentTime = 0; await audioEl.play().catch(() => {}); }
    rec.start();

    const start = performance.now();
    const drawLoop = async () => {
      while (!this.cancelled && (performance.now() - start) < duration * 1000) {
        const t = (performance.now() - start) / 1000;
        const objCanvas = this.objects
          ? this.objects.renderDisplay(this.fluid.canvas.width, this.fluid.canvas.height) : null;
        const merged = composite(this.fluid.canvas, objCanvas, spec.w, spec.h, this.brand.background);
        octx.clearRect(0, 0, spec.w, spec.h);
        octx.drawImage(merged, 0, 0);
        await this.composer.draw(octx, spec.w, spec.h, t);
        if (onProgress) onProgress(Math.min(1, t / duration));
        await new Promise(r => requestAnimationFrame(r));
      }
    };
    await drawLoop();

    rec.stop();
    await done;
    mixed.getTracks().forEach(t => t.stop());
    if (audioEl) audioEl.pause();
    if (audioCtx) audioCtx.close().catch(() => {});

    const blob = new Blob(chunks, { type: mime });
    const hasAudio = tracks.some(t => t.kind === 'audio');
    return { blob, ext: mime.includes('mp4') ? 'mp4' : 'webm', silent: !hasAudio };
  }

  /** Single poster frame at time t — for thumbnails and static placements. */
  async poster({ t = null, preset = 'instagram-feed' } = {}) {
    const spec = SHARE_PRESETS[preset] || SHARE_PRESETS.square;
    const time = t ?? this.composer.duration * 0.8;
    const out = document.createElement('canvas');
    out.width = spec.w; out.height = spec.h;
    const octx = out.getContext('2d');
    const objCanvas = this.objects
      ? this.objects.renderDisplay(this.fluid.canvas.width, this.fluid.canvas.height) : null;
    const merged = composite(this.fluid.canvas, objCanvas, spec.w, spec.h, this.brand.background);
    octx.drawImage(merged, 0, 0);
    await this.composer.draw(octx, spec.w, spec.h, time);
    return canvasToBlob(out);
  }
}
