/**
 * lokLiquid — tool contract + swipe deck
 *
 * Safari caps live WebGL contexts (roughly 8–16) and silently evicts the
 * oldest, which reads to a user as "a tool randomly went black". So the deck
 * doesn't just hide off-screen tools — it destroys their contexts beyond a
 * small window and remounts on approach.
 */

/**
 * @typedef {Object} LokTool
 * @property {(canvas: HTMLCanvasElement, opts?: object) => void} mount
 * @property {() => void} pause
 * @property {() => void} resume
 * @property {() => void} destroy
 * @property {() => Promise<Blob>} captureFrame
 * @property {() => object} getShareState
 */

export class ToolDeck {
  /**
   * @param {HTMLElement} root scroll-snap container
   * @param {Array<{id:string,label:string,create:()=>LokTool}>} defs
   */
  constructor(root, defs, { window: liveWindow = 1 } = {}) {
    this.root = root;
    this.defs = defs;
    this.liveWindow = liveWindow;      // how many neighbours stay mounted
    this.slots = [];
    this.index = 0;
    this._build();
    this._observe();
    this._sync();
  }

  _build() {
    this.root.innerHTML = '';
    this.root.classList.add('deck');
    this.defs.forEach((def, i) => {
      const panel = document.createElement('section');
      panel.className = 'deck-panel';
      panel.dataset.toolId = def.id;
      const canvas = document.createElement('canvas');
      panel.appendChild(canvas);
      this.root.appendChild(panel);
      this.slots.push({ def, panel, canvas, tool: null, mounted: false });
    });
  }

  _observe() {
    this._io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > 0.6) {
          const i = this.slots.findIndex(s => s.panel === e.target);
          if (i >= 0 && i !== this.index) { this.index = i; this._sync(); }
        }
      }
    }, { root: this.root, threshold: [0.6] });
    this.slots.forEach(s => this._io.observe(s.panel));
  }

  /** Mount what's near, destroy what's far, pause what's not focused. */
  _sync() {
    this.slots.forEach((slot, i) => {
      const dist = Math.abs(i - this.index);
      const shouldLive = dist <= this.liveWindow;

      if (shouldLive && !slot.mounted) {
        try {
          slot.tool = slot.def.create();
          slot.tool.mount(slot.canvas);
          slot.mounted = true;
        } catch (err) {
          console.warn('[deck] mount failed', slot.def.id, err);
        }
      } else if (!shouldLive && slot.mounted) {
        try { slot.tool.destroy(); } catch {}
        slot.tool = null;
        slot.mounted = false;
      }

      if (slot.mounted && slot.tool) {
        if (i === this.index) slot.tool.resume();
        else slot.tool.pause();          // truly paused, not just hidden
      }
    });
    this.onChange && this.onChange(this.defs[this.index], this.index);
  }

  get active() { return this.slots[this.index]?.tool || null; }

  goTo(i) {
    const slot = this.slots[i];
    if (!slot) return;
    slot.panel.scrollIntoView({ behavior: 'smooth', inline: 'start' });
  }

  destroy() {
    this._io && this._io.disconnect();
    this.slots.forEach(s => { if (s.tool) try { s.tool.destroy(); } catch {} });
    this.slots = [];
  }
}

/** Wraps LokFluid + ObjectLayer to satisfy the LokTool contract. */
export function makeFluidTool({ LokFluid, ObjectLayer, Capture, options = {} }) {
  let fluid = null, layer = null, capture = null;
  return {
    mount(canvas) {
      fluid = new LokFluid(canvas, options);
      layer = new ObjectLayer({ maskWidth: 512, maskHeight: 512 });
      fluid.setMaskSource(layer.maskCanvas);
      capture = new Capture(fluid, layer);
      fluid.start();
    },
    pause() { fluid && fluid.pause(); },
    resume() { fluid && fluid.resume(); },
    destroy() {
      if (capture) capture.dispose();
      if (fluid) fluid.destroy();
      fluid = layer = capture = null;
    },
    async captureFrame() {
      const f = await capture.snapshot();
      return f.blob;
    },
    getShareState() { return fluid ? fluid.getShareState() : {}; },
    get fluid() { return fluid; },
    get layer() { return layer; },
    get capture() { return capture; }
  };
}
