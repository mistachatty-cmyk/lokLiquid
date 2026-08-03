/**
 * lokLiquid — plotter / SVG export  (moat #3: physical output)
 *
 * Screen tools stop at pixels. This walks seed points through the velocity
 * field and emits them as SVG polylines — stroke paths a pen plotter or riso
 * separation can actually use. Nothing here rasterizes.
 */

/** Bilinear sample of the velocity field returned by fluid.sampleVelocity(). */
function sampleField(field, x, y) {
  const { width, height, data } = field;
  const fx = Math.min(Math.max(x, 0), 0.999) * (width - 1);
  const fy = Math.min(Math.max(y, 0), 0.999) * (height - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0, ty = fy - y0;
  const at = (px, py) => {
    const i = (py * width + px) * 4;
    return [data[i], data[i + 1]];
  };
  const [ax, ay] = at(x0, y0), [bx, by] = at(x1, y0);
  const [cx, cy] = at(x0, y1), [dx, dy] = at(x1, y1);
  const lerp = (a, b, t) => a + (b - a) * t;
  return [
    lerp(lerp(ax, bx, tx), lerp(cx, dx, tx), ty),
    lerp(lerp(ay, by, tx), lerp(cy, dy, tx), ty)
  ];
}

/**
 * Trace streamlines through the frozen velocity field.
 * @returns {Array<Array<[number,number]>>} polylines in 0..1 space
 */
function traceStreamlines(fluid, {
  count = 220, steps = 120, stepSize = 0.004, minLength = 0.05, seedJitter = true
} = {}) {
  const field = fluid.sampleVelocity();
  const rng = fluid.rng;
  const lines = [];

  for (let i = 0; i < count; i++) {
    let x, y;
    if (seedJitter) { x = rng(); y = rng(); }
    else {
      const cols = Math.ceil(Math.sqrt(count));
      x = ((i % cols) + 0.5) / cols;
      y = (Math.floor(i / cols) + 0.5) / cols;
    }
    const pts = [[x, y]];
    for (let s = 0; s < steps; s++) {
      const [vx, vy] = sampleField(field, x, y);
      const m = Math.hypot(vx, vy);
      if (m < 1e-3) break;
      x += (vx / m) * stepSize;
      y += (vy / m) * stepSize;
      if (x < 0 || x > 1 || y < 0 || y > 1) break;
      pts.push([x, y]);
    }
    // measure arc length; drop stubs that just clutter a plot
    let len = 0;
    for (let k = 1; k < pts.length; k++) {
      len += Math.hypot(pts[k][0] - pts[k-1][0], pts[k][1] - pts[k-1][1]);
    }
    if (len >= minLength) lines.push(pts);
  }
  return lines;
}

/** Douglas-Peucker — fewer points means a plotter that doesn't stutter. */
function simplify(points, tolerance = 0.0012) {
  if (points.length < 3) return points;
  const sq = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2;
  const segDist = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0]-x, dy = b[1]-y;
    if (dx || dy) {
      const t = ((p[0]-x)*dx + (p[1]-y)*dy) / (dx*dx + dy*dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx*t; y += dy*t; }
    }
    return (p[0]-x)**2 + (p[1]-y)**2;
  };
  const tol = tolerance * tolerance;
  const run = (first, last, out) => {
    let maxD = tol, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist(points[i], points[first], points[last]);
      if (d > maxD) { idx = i; maxD = d; }
    }
    if (idx > -1) { run(first, idx, out); out.push(points[idx]); run(idx, last, out); }
  };
  const out = [points[0]];
  const mid = [];
  run(0, points.length - 1, mid);
  mid.sort((a, b) => points.indexOf(a) - points.indexOf(b));
  return out.concat(mid, [points[points.length - 1]]);
}

/**
 * Emit plotter-ready SVG. Millimetre units, stroke-only, no fills, one group
 * per pen so a multi-pen plotter or riso separation can address layers.
 */
function toSVG(lines, {
  widthMm = 210, heightMm = 297, strokeMm = 0.35, margin = 12,
  pens = ['#111111'], objects = null, title = 'lokLiquid'
} = {}) {
  const w = widthMm, h = heightMm;
  const iw = w - margin * 2, ih = h - margin * 2;
  const fmt = (n) => n.toFixed(3).replace(/\.?0+$/, '');

  const groups = pens.map((color, pi) => {
    const mine = lines.filter((_, i) => i % pens.length === pi);
    const paths = mine.map(pts => {
      const d = pts.map((p, i) =>
        `${i ? 'L' : 'M'}${fmt(margin + p[0] * iw)},${fmt(margin + (1 - p[1]) * ih)}`
      ).join(' ');
      return `    <path d="${d}"/>`;
    }).join('\n');
    return `  <g id="pen-${pi + 1}" stroke="${color}" fill="none" ` +
           `stroke-width="${strokeMm}" stroke-linecap="round" stroke-linejoin="round">\n` +
           paths + '\n  </g>';
  }).join('\n');

  let objGroup = '';
  if (objects && objects.length) {
    const shapes = objects.filter(o => o.visible).map(o => {
      const t = o.transform;
      const size = Math.min(iw, ih) * t.scale;
      const cx = margin + t.x * iw, cy = margin + t.y * ih;
      if (o.kind === 'text') {
        return `    <text x="${fmt(cx)}" y="${fmt(cy)}" font-size="${fmt(size)}" ` +
               `text-anchor="middle" dominant-baseline="middle" fill="none" ` +
               `stroke="#111111" stroke-width="${strokeMm}">${escapeXml(o.text)}</text>`;
      }
      if (o.kind === 'pen' && o.points) {
        const d = o.points.map((p, i) =>
          `${i ? 'L' : 'M'}${fmt(margin + p[0] * iw)},${fmt(margin + p[1] * ih)}`
        ).join(' ') + (o.closed ? ' Z' : '');
        return `    <path d="${d}"/>`;
      }
      return `    <!-- symbol ${o.symbol} at ${fmt(cx)},${fmt(cy)} -->`;
    }).join('\n');
    objGroup = `\n  <g id="objects" fill="none" stroke="#111111" ` +
               `stroke-width="${strokeMm}">\n${shapes}\n  </g>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1"
     width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
  <title>${escapeXml(title)}</title>
${groups}${objGroup}
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** One call: field -> plotter file. */
function exportPlotterSVG(fluid, objectLayer, opts = {}) {
  const raw = traceStreamlines(fluid, opts);
  const lines = raw.map(l => simplify(l, opts.tolerance ?? 0.0012));
  const svg = toSVG(lines, {
    ...opts,
    objects: objectLayer ? objectLayer.objects : null
  });
  return new Blob([svg], { type: 'image/svg+xml' });
}
