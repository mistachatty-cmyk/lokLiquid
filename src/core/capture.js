/**
 * lokLiquid — capture & share
 *
 * Capture runs the sim OFFLINE (faster than realtime) using the seed, so an
 * export is not a recording — it's a regeneration. Live state is snapshotted
 * and restored so exporting never corrupts what's on screen.
 */

// ---------------------------------------------------------------------------
export const SHARE_PRESETS = {
  'instagram-feed':  { w: 1080, h: 1080, fps: 30, maxSec: 60,  label: 'Instagram Feed' },
  'instagram-story': { w: 1080, h: 1920, fps: 30, maxSec: 90,  label: 'Instagram Story' },
  'tiktok':          { w: 1080, h: 1920, fps: 30, maxSec: 60,  label: 'TikTok' },
  'youtube-short':   { w: 1080, h: 1920, fps: 30, maxSec: 60,  label: 'YouTube Short' },
  'youtube':         { w: 1920, h: 1080, fps: 30, maxSec: 600, label: 'YouTube' },
  'discord':         { w: 1080, h: 1080, fps: 30, maxSec: 60,  label: 'Discord', maxBytes: 25e6 },
  'messages':        { w: 1080, h: 1350, fps: 30, maxSec: 60,  label: 'Messages' },
  'whatsapp':        { w: 1080, h: 1080, fps: 30, maxSec: 60,  label: 'WhatsApp', maxBytes: 16e6 },
  'square':          { w: 1080, h: 1080, fps: 30, maxSec: 60,  label: 'Square' }
};

// ---------------------------------------------------------------------------
// composite: fluid canvas + object/text layer -> one output canvas
// ---------------------------------------------------------------------------
export function composite(fluidCanvas, objectCanvas, targetW, targetH, background = '#0B0A09') {
  const out = document.createElement('canvas');
  out.width = targetW; out.height = targetH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, targetW, targetH);

  // cover-fit the source into the target aspect
  const drawCover = (src) => {
    if (!src || !src.width) return;
    const sr = src.width / src.height, tr = targetW / targetH;
    let sw, sh, sx, sy;
    if (sr > tr) { sh = src.height; sw = sh * tr; sx = (src.width - sw) / 2; sy = 0; }
    else { sw = src.width; sh = sw / tr; sx = 0; sy = (src.height - sh) / 2; }
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, targetW, targetH);
  };
  drawCover(fluidCanvas);
  drawCover(objectCanvas);
  return out;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), type, quality);
  });
}

// ---------------------------------------------------------------------------
export class Capture {
  constructor(fluid, objectLayer) {
    this.fluid = fluid;
    this.objects = objectLayer;
    this.frames = [];       // [{ index, blob, url }]
  }

  /**
   * Deterministic offline render. Snapshots live state, regenerates from seed,
   * captures every `stride` frame, then restores.
   */
  async renderSequence({ frames = 60, stride = 1, preset = 'square', onProgress } = {}) {
    const f = this.fluid;
    const wasRunning = f._running;
    const snapshot = { frame: f.frame, time: f.time };
    f.stop();

    const spec = SHARE_PRESETS[preset] || SHARE_PRESETS.square;
    const out = [];

    f.reset();
    const objCanvas = this.objects
      ? this.objects.renderDisplay(f.canvas.width, f.canvas.height) : null;

    for (let i = 0; i < frames; i++) {
      f.stepFrame();
      if (i % stride !== 0) continue;
      const merged = composite(f.canvas, objCanvas, spec.w, spec.h);
      const blob = await canvasToBlob(merged);       // awaited — never fire-and-forget
      out.push({ index: i, blob, url: URL.createObjectURL(blob) });
      if (onProgress) onProgress((i + 1) / frames);
    }

    // restore
    f.reset();
    for (let i = 0; i < snapshot.frame; i++) f._step(1 / f.config.fps);
    f.frame = snapshot.frame; f.time = snapshot.time;
    f.render();
    if (wasRunning) f.start();

    this.frames = out;
    return out;
  }

  /** Single frame of exactly what's on screen right now. */
  async snapshot(preset = 'square') {
    const spec = SHARE_PRESETS[preset] || SHARE_PRESETS.square;
    const f = this.fluid;
    f.render();
    const objCanvas = this.objects
      ? this.objects.renderDisplay(f.canvas.width, f.canvas.height) : null;
    const merged = composite(f.canvas, objCanvas, spec.w, spec.h);
    const blob = await canvasToBlob(merged);
    return { index: f.frame, blob, url: URL.createObjectURL(blob) };
  }

  dispose() {
    for (const fr of this.frames) URL.revokeObjectURL(fr.url);
    this.frames = [];
  }
}

// ---------------------------------------------------------------------------
// share
// ---------------------------------------------------------------------------
export function canShareFiles() {
  try {
    if (!navigator.share || !navigator.canShare) return false;
    const probe = new File([new Blob(['x'])], 'probe.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch { return false; }
}

export async function shareBlob(blob, filename = 'lokliquid.png', text = '') {
  const file = new File([blob], filename, { type: blob.type });
  if (canShareFiles()) {
    try {
      await navigator.share({ files: [file], text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function checkSize(blob, preset) {
  const spec = SHARE_PRESETS[preset];
  if (!spec || !spec.maxBytes) return { ok: true };
  return blob.size <= spec.maxBytes
    ? { ok: true }
    : { ok: false, message: `${(blob.size / 1e6).toFixed(1)}MB exceeds ${spec.label}'s ${(spec.maxBytes / 1e6)}MB limit.` };
}

// ---------------------------------------------------------------------------
// seed links — moat #1: motion as ~200 bytes, not a video file
// ---------------------------------------------------------------------------
export function encodeState(state) {
  const json = JSON.stringify(state);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch { return null; }
}

export function buildShareLink(fluid, objectLayer) {
  const state = { v: 1, f: fluid.getShareState() };
  if (objectLayer && objectLayer.objects.length) {
    state.o = objectLayer.toJSON().map(o => ({
      k: o.kind, s: o.symbol, p: o.points, c: o.closed, t: o.text,
      tr: o.transform, r: o.reactive, vi: o.visible, m: o.mode, op: o.opacity
    }));
  }
  const base = location.origin + location.pathname;
  return base + '#m=' + encodeState(state);
}

export function readShareLink() {
  const m = location.hash.match(/m=([^&]+)/);
  return m ? decodeState(m[1]) : null;
}
