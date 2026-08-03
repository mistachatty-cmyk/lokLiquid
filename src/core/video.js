/**
 * lokLiquid — video export
 *
 * MediaRecorder over a captureStream, but fed from the OFFLINE deterministic
 * loop rather than the live canvas. We push frames at our own pace via
 * `requestFrame()`, so a slow device produces the same video as a fast one —
 * it just takes longer to write. That keeps the determinism moat intact
 * through video, which a plain screen-recording approach loses.
 */

export function videoSupported() {
  return typeof MediaRecorder !== 'undefined' &&
         typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1',          // Safari 17+ writes real mp4
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export class VideoExporter {
  constructor(fluid, objectLayer) {
    this.fluid = fluid;
    this.objects = objectLayer;
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  /**
   * @returns {Promise<{blob:Blob, mime:string, ext:string, frames:number}>}
   */
  /**
   * Live capture — used for audio-driven sessions, where motion depends on
   * real playback timing and is NOT reproducible from the seed alone. This
   * records the canvas as it actually renders in real time, unlike record()
   * which regenerates offline. Slower device = same wall-clock duration but
   * costs more dropped frames, which is an inherent tradeoff of going live;
   * it's the price of syncing to audio at all.
   * @returns {Promise<{blob:Blob, mime:string, ext:string}>}
   */
  async recordLive({ seconds = 8, fps = 30, bitrate = 12e6, onProgress, onStop } = {}) {
    if (!videoSupported()) throw new Error('This browser cannot record canvas video.');
    const mime = pickMimeType();
    if (!mime) throw new Error('No supported video codec.');

    const stream = this.fluid.canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, {
      mimeType: mime, videoBitsPerSecond: Math.min(bitrate, 20e6)
    });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });

    this.cancelled = false;
    rec.start();
    const start = performance.now();
    while (!this.cancelled && (performance.now() - start) < seconds * 1000) {
      if (onProgress) onProgress(Math.min(1, (performance.now() - start) / (seconds * 1000)));
      await new Promise(r => setTimeout(r, 100));
    }
    rec.stop();
    if (onStop) onStop();
    await done;
    stream.getTracks().forEach(t => t.stop());

    const blob = new Blob(chunks, { type: mime });
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    return { blob, mime, ext };
  }

  async record({ seconds = 4, preset = 'square', fps = 30, bitrate = 12e6, onProgress } = {}) {
    if (!videoSupported()) throw new Error('This browser cannot record canvas video.');
    const spec = SHARE_PRESETS[preset] || SHARE_PRESETS.square;
    const mime = pickMimeType();
    if (!mime) throw new Error('No supported video codec.');

    const f = this.fluid;
    const wasRunning = f._running;
    const snapshot = { frame: f.frame, time: f.time };
    f.stop();
    this.cancelled = false;

    // dedicated output canvas — never the live one, so recording can't
    // corrupt or be corrupted by what's on screen
    const out = document.createElement('canvas');
    out.width = spec.w; out.height = spec.h;
    const octx = out.getContext('2d');

    const stream = out.captureStream(0);          // 0 = we drive the frames
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.min(bitrate, 20e6)
    });

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });

    rec.start();

    const total = Math.round(seconds * fps);
    const step = f.config.fps / fps;             // sim steps per output frame
    f.reset();

    const objCanvas = this.objects
      ? this.objects.renderDisplay(f.canvas.width, f.canvas.height) : null;

    for (let i = 0; i < total; i++) {
      if (this.cancelled) break;
      for (let s = 0; s < Math.max(1, Math.round(step)); s++) f.stepFrame();

      const merged = composite(f.canvas, objCanvas, spec.w, spec.h);
      octx.drawImage(merged, 0, 0);
      if (track.requestFrame) track.requestFrame();
      else if (stream.requestFrame) stream.requestFrame();

      if (onProgress) onProgress((i + 1) / total);
      // yield so the recorder can drain and the UI can paint
      await new Promise(r => setTimeout(r, 0));
    }

    rec.stop();
    await done;
    track.stop();

    // restore live state exactly
    f.reset();
    for (let i = 0; i < snapshot.frame; i++) f._step(1 / f.config.fps);
    f.frame = snapshot.frame; f.time = snapshot.time;
    f.render();
    if (wasRunning) f.start();

    const blob = new Blob(chunks, { type: mime });
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    return { blob, mime, ext, frames: total };
  }
}
