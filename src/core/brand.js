/**
 * lokLiquid — brand kit
 *
 * Everything that makes an export belong to a specific client: logo, colour
 * palette, type, and the words that go on the end card. Kept separate from
 * the fluid so one brand can be applied across any tool, and so a client can
 * be handed a link that pre-loads their kit.
 *
 * Palette extraction is deliberate: rather than asking a client to type hex
 * codes, we pull the dominant colours out of their own logo and feed them
 * straight into the fluid's dye palette. Their brand colours become the
 * literal pigment in the water.
 */

const STORE_KEY = 'lokliquid.brands.v1';

export const DEFAULT_BRAND = {
  id: 'default',
  name: 'Untitled brand',
  logo: null,            // { dataUrl, aspect, kind:'svg'|'raster' }
  palette: [],           // ['#rrggbb', ...] display colours
  dyePalette: null,      // normalized [[r,g,b],...] fed to LokFluid
  accent: '#C8FF4D',
  background: '#0B0A09',
  font: '600 120px Inter, system-ui, sans-serif',
  headline: '',
  subline: '',
  cta: '',
  url: '',
  createdAt: null
};

// ---------------------------------------------------------------------------
// palette extraction — median-cut-lite over a downsampled image
// ---------------------------------------------------------------------------
/**
 * Pull up to `count` dominant colours from an image. Downsamples hard first
 * (64px) because we want broad brand colours, not photographic nuance, and
 * because this runs on phones.
 */
export async function extractPalette(source, count = 5) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);

  // collect opaque, non-near-white/black pixels — brand colour lives in between
  const pixels = [];
  for (let i = 0; i < S * S; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2], a = data[i*4+3];
    if (a < 128) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 245 && min > 245) continue;      // paper white
    if (max < 12) continue;                    // pure black
    pixels.push([r, g, b]);
  }
  if (!pixels.length) return ['#EDE9E3'];

  // median cut
  const buckets = [pixels];
  while (buckets.length < count) {
    // split the bucket with the widest channel range
    let bi = 0, bestRange = -1, bestCh = 0;
    buckets.forEach((bucket, i) => {
      if (bucket.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const p of bucket) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; bestCh = ch; }
      }
    });
    if (bestRange <= 0) break;
    const bucket = buckets[bi];
    bucket.sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = Math.floor(bucket.length / 2);
    buckets.splice(bi, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return buckets
    .filter(b => b.length)
    .map(b => {
      let r = 0, g = 0, bl = 0;
      for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
      return [r / b.length, g / b.length, bl / b.length];
    })
    .sort((a, b) => (b[0]+b[1]+b[2]) - (a[0]+a[1]+a[2]))
    .map(([r, g, b]) => `#${hex(r)}${hex(g)}${hex(b)}`);
}

/** Convert display hex colours into the low-intensity dye values the solver wants. */
export function paletteToDye(hexList, intensity = 0.16) {
  return hexList.map(h => {
    const n = h.replace('#', '');
    const r = parseInt(n.slice(0, 2), 16) / 255;
    const g = parseInt(n.slice(2, 4), 16) / 255;
    const b = parseInt(n.slice(4, 6), 16) / 255;
    // normalize so no single colour blows out, then scale to dye range
    const max = Math.max(r, g, b) || 1;
    return [(r / max) * intensity, (g / max) * intensity, (b / max) * intensity];
  });
}

// ---------------------------------------------------------------------------
export class BrandKit {
  constructor(data = {}) {
    Object.assign(this, DEFAULT_BRAND, data);
    if (!this.createdAt) this.createdAt = Date.now();
    if (!this.id || this.id === 'default') this.id = 'brand_' + Math.random().toString(36).slice(2, 9);
  }

  /** Load a logo file, extract its palette, and wire it into the dye. */
  async setLogo(file) {
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Could not read that logo file.'));
      r.readAsDataURL(file);
    });

    // measure aspect + extract colour by rasterizing (works for SVG too)
    const img = new Image();
    img.src = dataUrl;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('Could not decode that logo.'));
    });
    const aspect = (img.naturalWidth || 1) / (img.naturalHeight || 1);

    this.logo = { dataUrl, aspect, kind: isSvg ? 'svg' : 'raster' };

    try {
      const c = document.createElement('canvas');
      c.width = 128; c.height = Math.max(1, Math.round(128 / aspect));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const bmp = await createImageBitmap(c);
      const pal = await extractPalette(bmp, 5);
      if (pal.length) {
        this.palette = pal;
        this.dyePalette = paletteToDye(pal);
        this.accent = pal[0];
      }
    } catch { /* logo still usable without an extracted palette */ }

    return this;
  }

  /** Push this brand's colours into a live fluid instance. */
  applyToFluid(fluid) {
    if (this.dyePalette && this.dyePalette.length) {
      fluid.set('palette', this.dyePalette);
    }
    return this;
  }

  /** Load an <img> for the logo, cached, for compositing into frames. */
  async logoImage() {
    if (!this.logo) return null;
    if (this._logoImg) return this._logoImg;
    const img = new Image();
    img.src = this.logo.dataUrl;
    await img.decode().catch(() => {});
    this._logoImg = img;
    return img;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, logo: this.logo, palette: this.palette,
      dyePalette: this.dyePalette, accent: this.accent, background: this.background,
      font: this.font, headline: this.headline, subline: this.subline,
      cta: this.cta, url: this.url, createdAt: this.createdAt
    };
  }
}

// ---------------------------------------------------------------------------
// storage — several clients on one device
// ---------------------------------------------------------------------------
function safeStore() {
  try {
    const t = '__lok_probe__';
    localStorage.setItem(t, '1'); localStorage.removeItem(t);
    return localStorage;
  } catch { return null; }
}

export function listBrands() {
  const store = safeStore();
  if (!store) return [];
  try { return JSON.parse(store.getItem(STORE_KEY) || '[]').map(b => new BrandKit(b)); }
  catch { return []; }
}

export function saveBrand(brand) {
  const store = safeStore();
  if (!store) return false;
  const all = listBrands().filter(b => b.id !== brand.id);
  all.push(brand);
  try {
    store.setItem(STORE_KEY, JSON.stringify(all.map(b => b.toJSON())));
    return true;
  } catch (e) {
    // logo data URLs can blow the ~5MB quota — tell the caller honestly
    return false;
  }
}

export function deleteBrand(id) {
  const store = safeStore();
  if (!store) return;
  const all = listBrands().filter(b => b.id !== id);
  store.setItem(STORE_KEY, JSON.stringify(all.map(b => b.toJSON())));
}
