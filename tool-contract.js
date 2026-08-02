/**
 * lokLiquid — object system
 *
 * One model for everything that isn't fluid: preset symbols, pen-drawn shapes,
 * and text. All three collide with the fluid through a single mask texture.
 *
 * Mask encoding (RGBA canvas uploaded to the solver):
 *   R = solidity   255 = solid
 *   G = mode         0 = deflect, 128 = absorb, 255 = attract
 *   B = unused
 *   A = 255
 *
 * Rasterization is dirty-flagged: masks rebuild on create/edit/transform only,
 * never per simulation step.
 */

export const MODES = { deflect: 0, absorb: 128, attract: 255 };

/**
 * Interaction presets. Users pick a behaviour they can picture; the mode +
 * strength + rim values behind it are an implementation detail. This is the
 * streamlined surface — raw mode/strength stay available for fine tuning.
 */
export const INTERACTIONS = {
  rock:     { label: 'Rock',     mode: 'deflect', strength: 0.95, rim: 2.0,
              blurb: 'Hard edge. Fluid splits and races around it.' },
  stone:    { label: 'Stone',    mode: 'deflect', strength: 0.55, rim: 2.4,
              blurb: 'Softer obstacle — parts the flow without snapping it.' },
  sponge:   { label: 'Sponge',   mode: 'absorb',  strength: 0.9,  rim: 1.4,
              blurb: 'Drinks the current. Fluid slows and pools against it.' },
  magnet:   { label: 'Magnet',   mode: 'attract', strength: 0.75, rim: 1.8,
              blurb: 'Pulls flow inward so colour clings to the outline.' },
  membrane: { label: 'Membrane', mode: 'deflect', strength: 0.25, rim: 3.0,
              blurb: 'Barely there. Nudges the current rather than blocking it.' },
  ghost:    { label: 'Ghost',    mode: 'deflect', strength: 0,    rim: 0,
              blurb: 'No physics at all — visible, but the fluid ignores it.' }
};

export const INTERACTION_KEYS = Object.keys(INTERACTIONS);

// ---------------------------------------------------------------------------
// symbol library — outlines, normalized to a 0..1 box
// ---------------------------------------------------------------------------
const P = (d) => d;
export const SYMBOLS = {
  circle:   P('M0.5,0.06 A0.44,0.44 0 1,1 0.4999,0.06 Z'),
  ring:     P('M0.5,0.06 A0.44,0.44 0 1,1 0.4999,0.06 Z M0.5,0.24 A0.26,0.26 0 1,0 0.5001,0.24 Z'),
  square:   P('M0.08,0.08 H0.92 V0.92 H0.08 Z'),
  rounded:  P('M0.22,0.08 H0.78 Q0.92,0.08 0.92,0.22 V0.78 Q0.92,0.92 0.78,0.92 H0.22 Q0.08,0.92 0.08,0.78 V0.22 Q0.08,0.08 0.22,0.08 Z'),
  triangle: P('M0.5,0.07 L0.94,0.9 H0.06 Z'),
  star5:    P('M0.5,0.04 L0.62,0.36 L0.96,0.38 L0.69,0.59 L0.79,0.93 L0.5,0.73 L0.21,0.93 L0.31,0.59 L0.04,0.38 L0.38,0.36 Z'),
  star4:    P('M0.5,0.04 L0.60,0.40 L0.96,0.5 L0.60,0.60 L0.5,0.96 L0.40,0.60 L0.04,0.5 L0.40,0.40 Z'),
  heart:    P('M0.5,0.92 C0.1,0.62 0.04,0.36 0.2,0.22 C0.33,0.11 0.45,0.18 0.5,0.28 C0.55,0.18 0.67,0.11 0.8,0.22 C0.96,0.36 0.9,0.62 0.5,0.92 Z'),
  arrow:    P('M0.5,0.06 L0.86,0.46 H0.66 V0.94 H0.34 V0.46 H0.14 Z'),
  plus:     P('M0.38,0.08 H0.62 V0.38 H0.92 V0.62 H0.62 V0.92 H0.38 V0.62 H0.08 V0.38 H0.38 Z'),
  hexagon:  P('M0.5,0.05 L0.89,0.28 V0.72 L0.5,0.95 L0.11,0.72 V0.28 Z'),
  blob:     P('M0.52,0.07 C0.75,0.05 0.95,0.24 0.93,0.46 C0.91,0.68 0.98,0.83 0.76,0.91 C0.54,0.99 0.3,0.94 0.16,0.79 C0.02,0.64 0.03,0.38 0.15,0.24 C0.27,0.10 0.36,0.09 0.52,0.07 Z')
};

export const SYMBOL_NAMES = Object.keys(SYMBOLS);

let _id = 0;
const uid = () => 'obj_' + (++_id) + '_' + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------------------
export class LokObject {
  constructor(opts = {}) {
    this.id = opts.id || uid();
    this.kind = opts.kind || 'symbol';        // symbol | pen | text
    this.symbol = opts.symbol || null;
    this.points = opts.points || null;         // pen: [[x,y],...] normalized
    this.closed = opts.closed !== false;
    this.text = opts.text || '';
    this.font = opts.font || '600 120px Inter, system-ui, sans-serif';
    this.transform = { x: 0.5, y: 0.5, scale: 0.3, rotation: 0, ...(opts.transform || {}) };

    // four independent states
    this.visible = opts.visible !== false;
    this.reactive = opts.reactive !== false;
    this.mode = opts.mode || 'deflect';
    this.interaction = opts.interaction || null;   // preset name, if one was used
    this.strength = opts.strength ?? 0.9;          // 0..1 — how hard it pushes back
    this.rim = opts.rim ?? 2.0;                    // edge thickness multiplier
    this.opacity = opts.opacity ?? 1;
    this.locked = !!opts.locked;

    this.stroke = opts.stroke || '#EDE9E3';
    this.fill = opts.fill || null;
    this.lineWidth = opts.lineWidth ?? 0.012;
    this.blend = opts.blend || 'normal';
  }

  get label() {
    if (this.kind === 'text') return this.text.slice(0, 18) || 'Text';
    if (this.kind === 'pen') return 'Pen shape';
    return this.symbol || 'Symbol';
  }

  /** Open pen strokes have no interior — guard absorb/fill against them. */
  get hasInterior() { return (this.kind !== 'pen' || this.closed); }
  get isVectorless() { return this.kind === 'stencil'; }

  /** Apply a named preset, keeping raw fields in sync. */
  applyInteraction(name) {
    const p = INTERACTIONS[name];
    if (!p) return this;
    this.interaction = name;
    this.mode = p.mode;
    this.strength = p.strength;
    this.rim = p.rim;
    if (name === 'ghost') this.reactive = false;
    else if (this.strength > 0) this.reactive = true;
    return this;
  }

  effectiveMode() {
    if (this.mode === 'absorb' && !this.hasInterior) return 'deflect';
    return this.mode;
  }

  toJSON() {
    // Stencils carry a raster bitmap and SVGs carry raw path arrays — both
    // are too large for the ~200-byte seed-link moat, so they're excluded
    // from share state. They persist in-session and in exported files, just
    // not in the compact motion link.
    if (this.kind === 'stencil' || this.kind === 'svg') {
      return { id: this.id, kind: this.kind, excluded: true };
    }
    return {
      id: this.id, kind: this.kind, symbol: this.symbol, points: this.points,
      closed: this.closed, text: this.text, font: this.font,
      transform: { ...this.transform }, visible: this.visible,
      reactive: this.reactive, mode: this.mode, interaction: this.interaction,
      strength: this.strength, rim: this.rim, opacity: this.opacity,
      locked: this.locked, stroke: this.stroke, fill: this.fill,
      lineWidth: this.lineWidth, blend: this.blend
    };
  }
  static fromJSON(o) { return new LokObject(o); }
}

// ---------------------------------------------------------------------------
// pen smoothing — Catmull-Rom through the sampled points
// ---------------------------------------------------------------------------
export function smoothPath(points, tension = 0.5) {
  if (points.length < 3) return points.slice();
  const out = [];
  const p = points;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1];
    const p3 = p[Math.min(p.length - 1, i + 2)];
    for (let t = 0; t < 1; t += 0.25) {
      const t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t*tension*2 +
               (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
        0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t*tension*2 +
               (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
      ]);
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

/** Auto-close if the stroke ended near where it began. */
export function shouldClose(points, threshold = 0.06) {
  if (points.length < 8) return false;
  const a = points[0], b = points[points.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < threshold;
}

// ---------------------------------------------------------------------------
// ObjectLayer — owns the list, the mask canvas, and the display canvas
// ---------------------------------------------------------------------------
export class ObjectLayer {
  constructor({ maskWidth = 256, maskHeight = 256, maxReactive = 12 } = {}) {
    this.objects = [];
    this.maxReactive = maxReactive;
    this.dirty = true;                        // single flag drives BOTH mask + display

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = maskWidth;
    this.maskCanvas.height = maskHeight;
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: false });

    this.displayCanvas = document.createElement('canvas');
    this.displayCtx = this.displayCanvas.getContext('2d');

    this._fontsReady = false;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { this._fontsReady = true; this.invalidate(); });
    } else { this._fontsReady = true; }
  }

  invalidate() { this.dirty = true; }

  add(obj) {
    const o = obj instanceof LokObject ? obj : new LokObject(obj);
    this.objects.push(o);
    this.invalidate();
    return o;
  }
  remove(id) {
    this.objects = this.objects.filter(o => o.id !== id);
    this.invalidate();
  }
  get(id) { return this.objects.find(o => o.id === id); }
  reorder(from, to) {
    const [o] = this.objects.splice(from, 1);
    this.objects.splice(to, 0, o);
    this.invalidate();
  }
  update(id, patch) {
    const o = this.get(id);
    if (!o) return;
    Object.assign(o, patch);
    this.invalidate();
  }
  clear() { this.objects = []; this.invalidate(); }

  /** Reactive objects, capped — each is a mask sample and mobile GPUs feel it. */
  get reactiveObjects() {
    return this.objects.filter(o => o.reactive).slice(0, this.maxReactive);
  }

  /** Build a Path2D in pixel space for the given canvas size. */
  buildPath(obj, w, h, ctx) {
    const t = obj.transform;
    const size = Math.min(w, h) * t.scale;
    const path = new Path2D();
    const m = new DOMMatrix()
      .translateSelf(t.x * w, t.y * h)
      .rotateSelf((t.rotation * 180) / Math.PI)
      .scaleSelf(size, size)
      .translateSelf(-0.5, -0.5);

    if (obj.kind === 'symbol' && SYMBOLS[obj.symbol]) {
      path.addPath(new Path2D(SYMBOLS[obj.symbol]), m);
    } else if (obj.kind === 'pen' && obj.points && obj.points.length > 1) {
      const sub = new Path2D();
      const pts = obj.points;
      sub.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) sub.lineTo(pts[i][0], pts[i][1]);
      if (obj.closed) sub.closePath();
      // pen points are already normalized 0..1 across the full canvas
      path.addPath(sub, new DOMMatrix().scaleSelf(w, h));
    } else if (obj.kind === 'svg' && obj.svgPaths) {
      const n = obj.svgNormalize;
      const bbox = obj.svgBBox;
      // shift into the normalized 0..1 box, then apply the same object
      // transform used by every other kind
      const inner = new DOMMatrix()
        .scaleSelf(w, h)
        .translateSelf(n.offX, n.offY)
        .scaleSelf(n.scale, n.scale)
        .translateSelf(-bbox.minX, -bbox.minY);
      for (const d of obj.svgPaths) {
        try { path.addPath(new Path2D(d), m.multiply(inner)); } catch { /* skip bad node */ }
      }
    } else if (obj.kind === 'stencil') {
      return null;   // stencils are stamped as bitmaps, not vector paths
    } else if (obj.kind === 'text' && obj.text) {
      // glyph outlines: measured then drawn via ctx path emulation
      return null;   // text handled separately (needs ctx.fillText)
    }
    return path;
  }

  /** Rasterize the collision mask. Only runs when dirty. */
  renderMask() {
    const ctx = this.maskCtx;
    const w = this.maskCanvas.width, h = this.maskCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    for (const o of this.reactiveObjects) {
      if (o.strength <= 0) continue;             // ghost: reactive flag off anyway
      const modeVal = MODES[o.effectiveMode()];
      const strengthVal = Math.round(Math.max(0, Math.min(1, o.strength)) * 255);
      const color = `rgb(255, ${modeVal}, ${strengthVal})`;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (o.kind === 'text') {
        this._drawText(ctx, o, w, h, true);
        continue;
      }
      if (o.kind === 'stencil') {
        this._stampStencil(ctx, o, w, h, color);
        continue;
      }
      const path = this.buildPath(o, w, h, ctx);
      if (!path) continue;
      if (o.hasInterior) {
        ctx.fill(path);                       // solid body — fluid must actually feel it
        ctx.lineWidth = Math.max(3, o.lineWidth * Math.min(w, h) * o.rim);
        ctx.stroke(path);                     // thicken the rim so 128px sim resolves it
      } else {
        ctx.lineWidth = Math.max(6, o.lineWidth * Math.min(w, h) * (o.rim + 1));
        ctx.stroke(path);                     // open pen line: a wall, not a body
      }
    }
  }

  /** Stamp a thresholded raster stencil into the mask, tinted for mode. */
  _stampStencil(ctx, o, w, h, color) {
    const t = o.transform;
    const size = Math.min(w, h) * t.scale;
    const aw = size, ah = size / o.stencilAspect;
    ctx.save();
    ctx.translate(t.x * w, t.y * h);
    ctx.rotate(t.rotation);
    // recolor the stencil's opaque pixels to the mode color via compositing
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(o.stencilCanvas, -aw / 2, -ah / 2, aw, ah);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(-aw / 2, -ah / 2, aw, ah);
    ctx.restore();
  }

  /** Rasterize what the user actually sees. Same dirty flag as the mask. */
  renderDisplay(w, h) {
    const resized = this.displayCanvas.width !== w || this.displayCanvas.height !== h;
    if (resized) {
      this.displayCanvas.width = w;
      this.displayCanvas.height = h;
    }
    if (!resized && !this.dirty && this._displayDrawn) return this.displayCanvas;
    this._displayDrawn = true;
    const ctx = this.displayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    for (const o of this.objects) {
      if (!o.visible || o.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = o.opacity;
      ctx.globalCompositeOperation = o.blend === 'normal' ? 'source-over' :
        (o.blend === 'screen' ? 'screen' : 'multiply');

      if (o.kind === 'text') {
        this._drawText(ctx, o, w, h, false);
        ctx.restore();
        continue;
      }
      if (o.kind === 'stencil') {
        const t = o.transform;
        const size = Math.min(w, h) * t.scale;
        const aw = size, ah = size / o.stencilAspect;
        ctx.translate(t.x * w, t.y * h);
        ctx.rotate(t.rotation);
        if (o.fill) {
          ctx.drawImage(o.stencilCanvas, -aw / 2, -ah / 2, aw, ah);
          ctx.globalCompositeOperation = 'source-atop';
          ctx.fillStyle = o.fill;
          ctx.fillRect(-aw / 2, -ah / 2, aw, ah);
        } else {
          ctx.drawImage(o.stencilCanvas, -aw / 2, -ah / 2, aw, ah);
        }
        ctx.restore();
        continue;
      }
      const path = this.buildPath(o, w, h, ctx);
      if (path) {
        if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(path); }
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = Math.max(1, o.lineWidth * Math.min(w, h));
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
      ctx.restore();
    }
    return this.displayCanvas;
  }

  _drawText(ctx, o, w, h, isMask) {
    const t = o.transform;
    const px = Math.max(8, t.scale * Math.min(w, h));
    ctx.save();
    ctx.translate(t.x * w, t.y * h);
    ctx.rotate(t.rotation);
    ctx.font = o.font.replace(/\d+px/, Math.round(px) + 'px');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (isMask) {
      ctx.fillText(o.text, 0, 0);
      ctx.lineWidth = Math.max(3, px * 0.05);
      ctx.strokeText(o.text, 0, 0);
    } else {
      if (o.fill) { ctx.fillStyle = o.fill; ctx.fillText(o.text, 0, 0); }
      else {
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = Math.max(1, px * 0.02);
        ctx.strokeText(o.text, 0, 0);
      }
    }
    ctx.restore();
  }

  /** Call once per frame. Returns true if the mask changed (upload needed). */
  sync() {
    if (!this.dirty) return false;
    this.renderMask();
    this.dirty = false;
    return true;
  }

  /** Hit test in normalized coords, topmost first. */
  hitTest(nx, ny, w, h) {
    const ctx = this.displayCtx;
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const o = this.objects[i];
      if (o.locked || !o.visible) continue;
      if (o.kind === 'text') {
        const t = o.transform;
        const px = t.scale * Math.min(w, h);
        const approxW = px * 0.6 * Math.max(1, o.text.length) / 2;
        if (Math.abs(nx * w - t.x * w) < approxW && Math.abs(ny * h - t.y * h) < px * 0.7) return o;
        continue;
      }
      if (o.kind === 'stencil') {
        const t = o.transform;
        const size = Math.min(w, h) * t.scale;
        const aw = size, ah = size / o.stencilAspect;
        if (Math.abs(nx * w - t.x * w) < aw / 2 && Math.abs(ny * h - t.y * h) < ah / 2) return o;
        continue;
      }
      const path = this.buildPath(o, w, h, ctx);
      if (!path) continue;
      if (ctx.isPointInPath(path, nx * w, ny * h) ||
          ctx.isPointInStroke(path, nx * w, ny * h)) return o;
    }
    return null;
  }

  toJSON() { return this.objects.map(o => o.toJSON()); }
  loadJSON(arr) {
    this.objects = (arr || []).map(LokObject.fromJSON);
    this.invalidate();
  }
}
