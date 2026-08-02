/**
 * lokLiquid — ad engine
 *
 * Turns {brand + track + fluid} into a finished spot. The timeline is
 * beat-aware: cues snap to the detected grid so type lands on the beat
 * instead of drifting against it, which is the difference between "nice
 * background" and "an ad".
 *
 * Overlays composite at export time on top of the fluid frame — never baked
 * into the dye — so text stays crisp at any output resolution and can be
 * re-rendered for a different aspect without re-simulating.
 */

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------
/**
 * A template is a pure function of (brand, duration, bpm) -> cue list.
 * Each cue: { at, until, type, ...payload } in seconds.
 */
export const TEMPLATES = {
  'drop-reveal': {
    label: 'Drop reveal',
    blurb: 'Headline holds, logo slams in on the drop, CTA lands last.',
    build(brand, dur, beat) {
      const b = (n) => Math.min(dur, n * beat);
      return [
        { at: b(0),  until: b(8),        type: 'headline', text: brand.headline },
        { at: b(8),  until: b(16),       type: 'logo', scale: 0.34 },
        { at: b(14), until: dur,         type: 'cta', text: brand.cta, url: brand.url },
        { at: b(0),  until: dur,         type: 'vignette' }
      ];
    }
  },
  'lower-third': {
    label: 'Lower third',
    blurb: 'Fluid runs full-frame, brand sits quietly along the bottom.',
    build(brand, dur, beat) {
      return [
        { at: 0.4, until: dur, type: 'lowerthird',
          text: brand.headline || brand.name, sub: brand.subline },
        { at: Math.max(0, dur - 2.5), until: dur, type: 'cta', text: brand.cta, url: brand.url }
      ];
    }
  },
  'end-card': {
    label: 'End card',
    blurb: 'Pure motion, then a clean brand lockup for the final two seconds.',
    build(brand, dur, beat) {
      const hold = Math.min(2.6, dur * 0.35);
      return [
        { at: dur - hold, until: dur, type: 'scrim', opacity: 0.72 },
        { at: dur - hold + 0.15, until: dur, type: 'logo', scale: 0.3, y: 0.42 },
        { at: dur - hold + 0.5, until: dur, type: 'cta', text: brand.cta, url: brand.url, y: 0.62 }
      ];
    }
  },
  'beat-type': {
    label: 'Beat type',
    blurb: 'Headline words punch in one per bar, logo closes it out.',
    build(brand, dur, beat) {
      const words = (brand.headline || brand.name || '').split(/\s+/).filter(Boolean);
      const bar = beat * 2;
      const cues = words.map((w, i) => ({
        at: Math.min(dur - 0.4, i * bar),
        until: Math.min(dur, i * bar + bar * 1.4),
        type: 'word', text: w, index: i
      }));
      cues.push({ at: Math.max(0, dur - 2.2), until: dur, type: 'logo', scale: 0.28 });
      cues.push({ at: Math.max(0, dur - 1.4), until: dur, type: 'cta', text: brand.cta, url: brand.url });
      return cues;
    }
  },
  'clean': {
    label: 'Clean',
    blurb: 'Logo watermark only. Motion does the talking.',
    build(brand, dur) {
      return [{ at: 0, until: dur, type: 'watermark', scale: 0.12 }];
    }
  }
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

// ---------------------------------------------------------------------------
export class AdComposer {
  /**
   * @param {BrandKit} brand
   * @param {object} opts { template, durationSec, bpm }
   */
  constructor(brand, { template = 'drop-reveal', durationSec = 10, bpm = 120 } = {}) {
    this.brand = brand;
    this.template = template;
    this.duration = durationSec;
    this.bpm = bpm || 120;
    this.rebuild();
  }

  get beat() { return 60 / this.bpm; }

  rebuild() {
    const tpl = TEMPLATES[this.template] || TEMPLATES.clean;
    this.cues = tpl.build(this.brand, this.duration, this.beat) || [];
    return this;
  }

  set(key, value) {
    this[key] = value;
    this.rebuild();
    return this;
  }

  /** Cues active at time t, with a 0..1 progress value for animation. */
  activeAt(t) {
    return this.cues
      .filter(c => t >= c.at && t <= c.until)
      .map(c => ({ ...c, p: (t - c.at) / Math.max(0.001, c.until - c.at) }));
  }

  /**
   * Draw the overlay for time `t` onto a 2D context sized w x h.
   * Pure draw — no state mutation, so it's safe to call per export frame.
   */
  async draw(ctx, w, h, t) {
    const brand = this.brand;
    const logo = await brand.logoImage();
    const S = Math.min(w, h);
    const ease = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);
    // short in/out envelope so nothing pops hard on or off
    const env = (p, inT = 0.12, outT = 0.12) => {
      if (p < inT) return ease(p / inT);
      if (p > 1 - outT) return ease((1 - p) / outT);
      return 1;
    };

    for (const cue of this.activeAt(t)) {
      const a = env(cue.p);
      if (a <= 0.001) continue;
      ctx.save();
      ctx.globalAlpha = a;

      switch (cue.type) {
        case 'vignette': {
          const g = ctx.createRadialGradient(w/2, h/2, S*0.25, w/2, h/2, S*0.85);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(0,0,0,0.55)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
          break;
        }
        case 'scrim': {
          ctx.fillStyle = brand.background || '#0B0A09';
          ctx.globalAlpha = a * (cue.opacity ?? 0.7);
          ctx.fillRect(0, 0, w, h);
          break;
        }
        case 'headline': {
          if (!cue.text) break;
          const size = S * 0.085;
          ctx.font = brand.font.replace(/\d+px/, Math.round(size) + 'px');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,.5)';
          ctx.shadowBlur = size * 0.25;
          const rise = (1 - ease(Math.min(1, cue.p * 4))) * size * 0.5;
          wrapText(ctx, cue.text, w/2, h*0.42 + rise, w*0.82, size*1.22);
          break;
        }
        case 'word': {
          if (!cue.text) break;
          const size = S * 0.13;
          ctx.font = brand.font.replace(/\d+px/, Math.round(size) + 'px');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,.5)';
          ctx.shadowBlur = size * 0.2;
          const punch = 1 + (1 - ease(Math.min(1, cue.p * 6))) * 0.18;
          ctx.translate(w/2, h*0.45);
          ctx.scale(punch, punch);
          ctx.fillText(cue.text, 0, 0);
          break;
        }
        case 'lowerthird': {
          const pad = S * 0.055;
          const size = S * 0.045;
          const barH = size * (cue.sub ? 3.0 : 2.0);
          const slide = (1 - ease(Math.min(1, cue.p * 8))) * barH;
          ctx.translate(0, slide);
          const g = ctx.createLinearGradient(0, h - barH - pad, 0, h);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(0,0,0,0.72)');
          ctx.fillStyle = g;
          ctx.fillRect(0, h - barH - pad*2, w, barH + pad*2);
          ctx.fillStyle = brand.accent || '#fff';
          ctx.fillRect(pad, h - barH - pad*0.2, S*0.012, barH*0.72);
          ctx.font = brand.font.replace(/\d+px/, Math.round(size) + 'px');
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = '#fff';
          ctx.fillText(cue.text || '', pad + S*0.035, h - barH + size*0.7);
          if (cue.sub) {
            ctx.globalAlpha = a * 0.72;
            ctx.font = brand.font.replace(/\d+px/, Math.round(size*0.62) + 'px');
            ctx.fillText(cue.sub, pad + S*0.035, h - barH + size*1.95);
          }
          break;
        }
        case 'logo':
        case 'watermark': {
          if (!logo) break;
          const isMark = cue.type === 'watermark';
          const targetW = S * (cue.scale ?? (isMark ? 0.12 : 0.3));
          const lw = targetW, lh = targetW / (brand.logo.aspect || 1);
          const cx = isMark ? w - lw/2 - S*0.05 : w/2;
          const cy = isMark ? h - lh/2 - S*0.05 : h * (cue.y ?? 0.46);
          const pop = isMark ? 1 : 1 + (1 - ease(Math.min(1, cue.p * 5))) * 0.12;
          if (isMark) ctx.globalAlpha = a * 0.75;
          ctx.translate(cx, cy);
          ctx.scale(pop, pop);
          ctx.drawImage(logo, -lw/2, -lh/2, lw, lh);
          break;
        }
        case 'cta': {
          if (!cue.text && !cue.url) break;
          const size = S * 0.038;
          const label = [cue.text, cue.url].filter(Boolean).join('   ');
          ctx.font = brand.font.replace(/\d+px/, Math.round(size) + 'px');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const metrics = ctx.measureText(label);
          const padX = size * 1.1, padY = size * 0.62;
          const bw = metrics.width + padX*2, bh = size + padY*2;
          const y = h * (cue.y ?? 0.86);
          const rise = (1 - ease(Math.min(1, cue.p * 5))) * size;
          ctx.translate(w/2, y + rise);
          ctx.fillStyle = brand.accent || '#C8FF4D';
          roundRect(ctx, -bw/2, -bh/2, bw, bh, bh/2);
          ctx.fill();
          ctx.fillStyle = brand.background || '#0B0A09';
          ctx.fillText(label, 0, 1);
          break;
        }
      }
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
}
