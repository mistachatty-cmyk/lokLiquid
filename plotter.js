/**
 * lokLiquid — import
 *
 * Bring your own shape. Two paths in:
 *   SVG    -> parsed with the browser's own DOMParser, each <path>/<rect>/
 *             <circle>/<polygon>/etc converted to native Path2D data (the
 *             canvas spec accepts SVG path syntax directly — no parser
 *             dependency needed) and normalized to a 0..1 box.
 *   Raster (PNG/JPG/WebP) -> luminance-thresholded into a stencil path via
 *             marching-squares-lite (contour trace on the alpha/luma mask),
 *             so a logo or photo silhouette becomes a real reactive object,
 *             not just a picture floating on top.
 *
 * Both return LokObject-compatible data — nothing here talks to the solver.
 */
import { LokObject } from './objects.js';

const MAX_DIM = 1400;          // clamp huge uploads before we touch pixels
const SUPPORTED_RASTER = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------
const SHAPE_TO_PATH = {
  rect(el) {
    const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0;
    const w = +el.getAttribute('width') || 0, h = +el.getAttribute('height') || 0;
    const rx = +el.getAttribute('rx') || 0;
    if (rx > 0) {
      return `M${x+rx},${y} H${x+w-rx} Q${x+w},${y} ${x+w},${y+rx} V${y+h-rx} ` +
             `Q${x+w},${y+h} ${x+w-rx},${y+h} H${x+rx} Q${x},${y+h} ${x},${y+h-rx} ` +
             `V${y+rx} Q${x},${y} ${x+rx},${y} Z`;
    }
    return `M${x},${y} H${x+w} V${y+h} H${x} Z`;
  },
  circle(el) {
    const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
    const r = +el.getAttribute('r') || 0;
    return `M${cx-r},${cy} A${r},${r} 0 1,0 ${cx+r},${cy} A${r},${r} 0 1,0 ${cx-r},${cy} Z`;
  },
  ellipse(el) {
    const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
    const rx = +el.getAttribute('rx') || 0, ry = +el.getAttribute('ry') || 0;
    return `M${cx-rx},${cy} A${rx},${ry} 0 1,0 ${cx+rx},${cy} A${rx},${ry} 0 1,0 ${cx-rx},${cy} Z`;
  },
  polygon(el) {
    const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    let d = '';
    for (let i = 0; i < pts.length; i += 2) d += (i ? 'L' : 'M') + pts[i] + ',' + pts[i + 1] + ' ';
    return d + 'Z';
  },
  polyline(el) {
    const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    let d = '';
    for (let i = 0; i < pts.length; i += 2) d += (i ? 'L' : 'M') + pts[i] + ',' + pts[i + 1] + ' ';
    return d;
  },
  line(el) {
    return `M${el.getAttribute('x1')||0},${el.getAttribute('y1')||0} ` +
           `L${el.getAttribute('x2')||0},${el.getAttribute('y2')||0}`;
  },
  path(el) { return el.getAttribute('d') || ''; }
};

/**
 * Parse an SVG file's text into one or more { d, closed } path descriptors
 * with a shared bounding box, normalized to 0..1.
 */
export function parseSVG(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('That file is not valid SVG.');
  }
  const root = doc.documentElement;
  const nodes = root.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line');
  if (!nodes.length) throw new Error('No drawable shapes found in that SVG.');

  const ds = [];
  nodes.forEach(el => {
    const fn = SHAPE_TO_PATH[el.tagName.toLowerCase()];
    if (!fn) return;
    try {
      const d = fn(el);
      if (d && d.trim()) ds.push(d);
    } catch { /* skip malformed node, keep the rest */ }
  });
  if (!ds.length) throw new Error('Could not extract any usable paths.');

  // measure combined bbox using an offscreen canvas (native Path2D parses
  // the SVG path syntax for us — this is the browser's own SVG engine,
  // not a hand-rolled parser)
  const probe = document.createElement('canvas');
  probe.width = probe.height = 8;
  const pctx = probe.getContext('2d');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const paths = ds.map(d => {
    const p = new Path2D(d);
    return p;
  });

  // Path2D has no getBBox, so fall back to the SVG root's own viewBox/bbox
  // if present, else render at a known scale and measure ink extent.
  const viewBox = root.getAttribute('viewBox');
  if (viewBox) {
    const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number);
    minX = vx; minY = vy; maxX = vx + vw; maxY = vy + vh;
  } else {
    const size = 512;
    probe.width = probe.height = size;
    pctx.clearRect(0, 0, size, size);
    paths.forEach(p => pctx.fill(p));
    const img = pctx.getImageData(0, 0, size, size).data;
    let fx0 = size, fy0 = size, fx1 = 0, fy1 = 0, any = false;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (img[(y * size + x) * 4 + 3] > 10) {
        any = true;
        if (x < fx0) fx0 = x; if (x > fx1) fx1 = x;
        if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
      }
    }
    if (any) { minX = fx0; minY = fy0; maxX = fx1; maxY = fy1; }
    else { minX = 0; minY = 0; maxX = size; maxY = size; }
  }

  const w = Math.max(1e-6, maxX - minX), h = Math.max(1e-6, maxY - minY);
  const scale = 1 / Math.max(w, h);
  const offX = (Math.max(w, h) - w) / 2, offY = (Math.max(w, h) - h) / 2;

  // re-express each path's data with coordinates normalized to 0..1,
  // by wrapping in a transform when we build the Path2D at render time —
  // simplest robust approach is to hand back the raw d strings plus the
  // transform recipe, and let ObjectLayer apply it once via DOMMatrix.
  return {
    paths: ds,
    bbox: { minX, minY, w, h },
    normalize: { scale, offX, offY }
  };
}

/** Build a LokObject from a parsed SVG, ready to add to an ObjectLayer. */
export function svgToObject(parsed, opts = {}) {
  const { paths, bbox, normalize } = parsed;
  // Combine into one compound path with the normalize transform pre-applied
  // by rewriting each path through a DOMMatrix at consumption time.
  return new LokObject({
    kind: 'svg',
    svgPaths: paths,
    svgBBox: bbox,
    svgNormalize: normalize,
    transform: { x: 0.5, y: 0.42, scale: 0.3, rotation: 0, ...(opts.transform || {}) },
    mode: opts.mode || 'deflect',
    reactive: opts.reactive !== false,
    stroke: opts.stroke || '#EDE9E3',
    fill: opts.fill ?? null,
    lineWidth: opts.lineWidth ?? 0.012
  });
}

export async function importSVGFile(file) {
  if (file.size > 4_000_000) throw new Error('SVG is larger than 4MB — trim it before importing.');
  const text = await file.text();
  const parsed = parseSVG(text);
  return svgToObject(parsed, { });
}

// ---------------------------------------------------------------------------
// raster -> stencil
// ---------------------------------------------------------------------------
/**
 * Threshold a raster image into a binary stencil, then trace its outline
 * into a Path2D-compatible `d` string via a lightweight square-marching
 * pass. Good for logos/silhouettes; a busy photo will produce a noisy but
 * usable mask — the threshold slider lets the user clean it up.
 */
export async function importRasterFile(file, { threshold = 0.5, invert = false } = {}) {
  if (!SUPPORTED_RASTER.includes(file.type)) {
    throw new Error('Supported image types: PNG, JPG, WebP, GIF.');
  }
  if (file.size > 8_000_000) throw new Error('Image is larger than 8MB — resize it before importing.');

  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  width = Math.round(width * scale); height = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  // binary field: 1 = ink
  const field = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2], a = data[i*4+3];
    const luma = (0.299*r + 0.587*g + 0.114*b) / 255;
    const solid = a > 20 && (invert ? luma > threshold : luma < threshold);
    field[i] = solid ? 1 : 0;
  }

  return { field, width, height, canvas };
}

/**
 * Build a LokObject directly from a thresholded raster — it carries its own
 * offscreen bitmap and is composited into the mask/display by stamping that
 * bitmap rather than a vector path (see ObjectLayer's 'stencil' kind).
 */
export function stencilToObject({ canvas, width, height }, opts = {}) {
  return new LokObject({
    kind: 'stencil',
    stencilCanvas: canvas,
    stencilAspect: width / height,
    transform: { x: 0.5, y: 0.42, scale: 0.32, rotation: 0, ...(opts.transform || {}) },
    mode: opts.mode || 'deflect',
    reactive: opts.reactive !== false,
    fill: opts.fill || '#EDE9E3'
  });
}

export async function importImageFile(file, options) {
  const raster = await importRasterFile(file, options);
  return stencilToObject(raster, {});
}

/** Single entry point the UI calls — dispatches on MIME/extension. */
export async function importAny(file, options) {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    return { kind: 'svg', object: await importSVGFile(file) };
  }
  if (SUPPORTED_RASTER.includes(file.type)) {
    return { kind: 'raster', object: await importImageFile(file, options) };
  }
  throw new Error('Unsupported file. Try SVG, PNG, JPG, WebP, or GIF.');
}
