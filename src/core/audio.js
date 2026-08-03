/**
 * lokLiquid — audio-reactive auto-motion
 *
 * Turns an uploaded audio file (or a direct, CORS-enabled audio URL) into
 * fluid motion automatically: no drawing required. Three bands (bass/mid/
 * treble) drive splat force, curl, and color; a lightweight energy-based
 * beat detector fires stronger splats on hits.
 *
 * IMPORTANT SCOPE NOTE — read before wiring a "paste any link" UI:
 * Web Audio can only analyze audio it can decode into an AudioBuffer/
 * MediaElementSource, and cross-origin sources need CORS headers on the
 * *source* to allow that. A direct .mp3/.wav/.m4a URL from a CORS-enabled
 * host works. A YouTube/Spotify/SoundCloud page link does NOT — those are
 * not raw audio files, extracting audio from them requires either their
 * official API (SoundCloud has one; YouTube's terms prohibit extraction)
 * or a server-side download step, which is a backend project, not a
 * front-end feature. This module deliberately supports file upload and
 * direct audio URLs only, and the UI should say so rather than accept an
 * arbitrary link and fail silently.
 */

export function audioSupported() {
  return typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined';
}

const CTX = window.AudioContext || window.webkitAudioContext;

// ---------------------------------------------------------------------------
export class AudioDriver {
  /**
   * @param {LokFluid} fluid
   * @param {ObjectLayer=} objectLayer  optional — lets a hidden word/logo
   *        reveal itself on beat by toggling `reactive` momentarily
   */
  constructor(fluid, objectLayer = null) {
    this.fluid = fluid;
    this.objects = objectLayer;
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.el = null;              // <audio> element when playing a file/URL
    this.freqData = null;
    this.timeData = null;
    this.running = false;
    this._raf = null;

    // rolling energy history for beat detection (per docs: compare
    // instantaneous energy against a short local average, fire on a
    // threshold multiple — the standard browser beat-detection technique)
    this._energyHistory = [];
    this._historySize = 43;      // ~1s at 60fps-ish poll
    this._lastBeat = 0;
    this._beatCooldownMs = 220;

    this.bands = { bass: 0, mid: 0, treble: 0, overall: 0 };
    this.onBeat = null;          // user hook
  }

  /** Load a local file (drag/drop or <input type=file>). */
  async loadFile(file) {
    const url = URL.createObjectURL(file);
    await this._loadURL(url, true);
  }

  /** Load a direct, CORS-enabled audio URL. Not a YouTube/Spotify page link — see module note. */
  async loadURL(url) {
    await this._loadURL(url, false);
  }

  async _loadURL(url, revokeOnEnd) {
    this.stop();
    this.ctx = new CTX();
    this.el = new Audio();
    this.el.crossOrigin = 'anonymous';
    this.el.src = url;
    this.el.loop = true;
    this.el.preload = 'auto';

    await new Promise((resolve, reject) => {
      const onErr = () => reject(new Error(
        'Could not load that audio. If this is a link, it must be a direct ' +
        'audio file URL with CORS enabled — page links (YouTube, SoundCloud ' +
        'web player, Spotify) can\'t be decoded in-browser.'
      ));
      this.el.addEventListener('canplaythrough', resolve, { once: true });
      this.el.addEventListener('error', onErr, { once: true });
      setTimeout(() => reject(new Error('Audio load timed out.')), 15000);
    });

    this.source = this.ctx.createMediaElementSource(this.el);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.75;
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);

    if (revokeOnEnd) {
      this.el.addEventListener('emptied', () => URL.revokeObjectURL(url), { once: true });
    }
  }

  async play() {
    if (!this.el) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.el.play();
    this.running = true;
    this._loop();
  }

  pause() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.el) this.el.pause();
  }

  stop() {
    this.pause();
    if (this.el) { this.el.src = ''; this.el = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.source = null;
    this.analyser = null;
    this._energyHistory = [];
  }

  /** One frame of analysis + driving the fluid. Called on rAF while playing. */
  _tick() {
    const a = this.analyser;
    a.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;

    // three broad bands — good enough for visual response without a full FFT UI
    const bassEnd = Math.floor(n * 0.08);
    const midEnd = Math.floor(n * 0.35);
    const avg = (from, to) => {
      let s = 0; for (let i = from; i < to; i++) s += this.freqData[i];
      return s / Math.max(1, to - from) / 255;
    };
    const bass = avg(0, bassEnd), mid = avg(bassEnd, midEnd), treble = avg(midEnd, n);
    const overall = (bass * 0.5 + mid * 0.3 + treble * 0.2);
    this.bands = { bass, mid, treble, overall };

    // beat detection: instantaneous bass energy vs. rolling local average
    this._energyHistory.push(bass);
    if (this._energyHistory.length > this._historySize) this._energyHistory.shift();
    const localAvg = this._energyHistory.reduce((s, v) => s + v, 0) / this._energyHistory.length;
    const now = performance.now();
    const isBeat = bass > localAvg * 1.35 && bass > 0.15 &&
                   (now - this._lastBeat) > this._beatCooldownMs;
    if (isBeat) { this._lastBeat = now; this._onBeat(bass); }

    this._driveAmbient(overall, bass, treble);
  }

  _driveAmbient(overall, bass, treble) {
    const f = this.fluid;
    // continuous response: curl and dissipation breathe with the mix
    f.config.curl = 14 + overall * 60;
    f.config.velocityDissipation = 0.35 - treble * 0.15;
    // sparse ambient splats scale with loudness rather than firing every frame
    f._ambientAcc = (f._ambientAcc || 0) + overall * 0.35;
  }

  _onBeat(strength) {
    const f = this.fluid;
    const r = f.rng;
    const count = 1 + Math.round(strength * 2);
    for (let i = 0; i < count; i++) {
      const x = r(), y = r();
      const a = r() * Math.PI * 2;
      const mag = 2500 + strength * 6000;
      f.splat(x, y, Math.cos(a) * mag, Math.sin(a) * mag);
    }
    // momentarily reveal a hidden reactive object on strong hits — the
    // reveal-through-motion moat, now automated by the music itself
    if (this.objects && strength > 0.4) {
      const hidden = this.objects.objects.find(o => o.reactive && !o.visible);
      if (hidden) {
        hidden.visible = true;
        this.objects.invalidate();
        setTimeout(() => { hidden.visible = false; this.objects.invalidate(); }, 260);
      }
    }
    if (this.onBeat) this.onBeat(strength);
  }

  _loop() {
    if (!this.running) return;
    this._tick();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  get duration() { return this.el ? this.el.duration : 0; }
  get currentTime() { return this.el ? this.el.currentTime : 0; }
  seekTo(t) { if (this.el) this.el.currentTime = t; }
}

// ---------------------------------------------------------------------------
// offline tempo estimate — self-contained, no dependency
// ---------------------------------------------------------------------------
/**
 * Rough BPM estimate from a decoded AudioBuffer using a low-pass energy
 * envelope and autocorrelation over candidate intervals. Good enough to
 * pick a sensible default video export length (e.g. snap to 8/16 bars),
 * not a mastering-grade beat grid.
 */
export async function estimateTempo(arrayBuffer, { minBpm = 70, maxBpm = 180 } = {}) {
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;

  // crude low-pass via block RMS as a stand-in for a kick-drum envelope
  const hop = Math.floor(sr * 0.01);                 // 10ms
  const env = [];
  for (let i = 0; i < data.length; i += hop) {
    let sum = 0;
    for (let j = i; j < Math.min(i + hop, data.length); j++) sum += data[j] * data[j];
    env.push(Math.sqrt(sum / hop));
  }

  let bestBpm = 120, bestScore = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
    const period = Math.round((60 / bpm) / 0.01);    // in envelope-frames
    if (period < 2 || period >= env.length) continue;
    let score = 0;
    for (let i = 0; i + period < env.length; i++) score += env[i] * env[i + period];
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  return Math.round(bestBpm);
}
