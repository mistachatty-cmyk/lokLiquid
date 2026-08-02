/**
 * lokLiquid — help layer
 *
 * Explanations that work everywhere, because "hover" doesn't exist on the
 * device most of this gets used on.
 *
 * Three ways in, same content:
 *   1. Desktop hover      — native tooltip via `title`, plus a styled popover
 *   2. Touch long-press   — 450ms hold on any labelled control
 *   3. Help mode          — tap "?" in the top bar; every labelled control
 *                           gets a marker, and a single tap explains it
 *                           instead of activating it
 *
 * Content lives in one map so wording stays consistent and translatable
 * later, rather than being scattered across `title` attributes in markup.
 */

export const HELP = {
  // modes
  'mode-draw': ['Draw', 'Drag on the canvas to push the fluid around. This is the default tool.'],
  'mode-pen': ['Pen', 'Draw a freehand shape. Finish near where you started and it closes into a solid object the fluid collides with.'],
  'mode-move': ['Move', 'Tap an object to select it, then drag to reposition. Use the Layers sheet to resize or rotate.'],

  // sheets
  'open-symbols': ['Symbols', 'Drop in a ready-made shape. Each one becomes a physical obstacle in the fluid.'],
  'open-text': ['Text', 'Place words that the fluid flows around. Text can also be hidden but still reactive, so the motion reveals it.'],
  'open-layers': ['Layers', 'Every object you have placed, newest first. Control what is visible, what the fluid reacts to, and how.'],
  'open-studio': ['Studio', 'Capture frames, record video, export plotter files, and copy a motion link.'],
  'open-frames': ['Frames', 'Everything you have captured this session. Save or post any frame.'],
  'open-import': ['Import', 'Bring in your own SVG or image and turn it into an object the fluid interacts with.'],
  'open-auto': ['Auto', 'Let a track drive the motion for you — no drawing needed.'],
  'open-adstudio': ['Ad Studio', 'The full client workflow: brand, track, template, finished ad.'],
  'open-tune': ['Tune', 'Change how the fluid itself behaves — flow character, fade, and brush size.'],

  // interaction
  'interaction': ['Interaction', 'How this object and the fluid affect each other. Pick the behaviour you want; the physics behind it is handled for you.'],
  'strength': ['Strength', 'How forcefully the object pushes back. Low values let the fluid pass through more easily.'],
  'slip': ['Slip', 'How freely fluid slides along an edge. High slip glides past like glass; low slip drags like cloth.'],
  'reactive-dot': ['Reacts', 'Green means the fluid collides with this object. Independent of whether you can see it.'],
  'visible-eye': ['Visible', 'Whether the object is drawn. An object can be invisible and still reactive — that is how a hidden word gets revealed by the flow.'],

  // tune
  'curl': ['Curl', 'How much the fluid swirls. Low is calm and smoky, high is turbulent and energetic.'],
  'fade': ['Fade', 'How quickly colour dissipates. Low leaves long trails, high clears fast.'],
  'radius': ['Radius', 'Size of the splat your finger or cursor makes.'],
  'preset-fluid': ['Look presets', 'Starting points for the fluid character. You can adjust anything afterwards.'],
  'reseed': ['Reseed', 'Jump to a new random starting state. Every seed is reproducible — copy a motion link to keep one.'],
  'step': ['Step', 'Advance a single frame. Useful for landing on an exact moment before capturing.'],

  // studio
  'export-format': ['Format', 'Output size. Story/Reel/TikTok is 9:16, Feed is square, YouTube is 16:9.'],
  'snapshot': ['Snapshot', 'Capture exactly what is on screen right now as a single frame.'],
  'render-sequence': ['Render sequence', 'Regenerate the motion from its seed and capture a run of frames. Faster than real time and identical on every device.'],
  'record-video': ['Record video', 'Export a video file. Rendered offline from the seed, so device speed does not change the result.'],
  'plot-lines': ['Plot lines', 'How many stroke paths to trace. More lines means denser artwork and a longer plot time.'],
  'export-svg': ['Plotter SVG', 'Export as real stroke paths in millimetres for a pen plotter or riso separation. Nothing is rasterised.'],
  'copy-link': ['Motion link', 'Copies a tiny link that reproduces this exact motion anywhere. About 200 bytes — it regenerates rather than storing a video.'],

  // import
  'import-file': ['Import file', 'SVG imports as vector shapes. Photos and logos import as a silhouette the fluid can collide with.'],
  'import-threshold': ['Threshold', 'Where the cutoff sits between shape and background when converting an image. Adjust until the silhouette looks clean.'],

  // audio
  'audio-file': ['Audio file', 'Upload a track to drive the motion. Bass fires splats, treble thins the fluid.'],
  'audio-url': ['Audio link', 'Must point directly at an audio file with CORS enabled. Streaming service page links cannot be decoded in a browser.'],
  'audio-play': ['Play', 'Starts the track and hands control of the fluid to the music.'],
  'audio-render': ['Auto-render', 'Records video while the track plays. Captured live, so it is not seed-reproducible — plain exports still are.'],

  // ad studio
  'brand-logo': ['Logo', 'Upload the client mark. Colours are pulled from it automatically and become the pigment in the fluid.'],
  'brand-save': ['Save brand', 'Stores this kit on this device so you can reuse it across campaigns.'],
  'ad-track': ['Client track', 'The song is analysed once for its beat grid, then that data drives the render.'],
  'ad-template': ['Template', 'Layout and timing. Cues snap to the detected beat so type lands on the hit.'],
  'ad-duration': ['Length', 'Spot duration. Capped to the length of the uploaded track.'],
  'ad-render-silent': ['Render (silent, exact)', 'Offline render driven by the extracted beat data. Reproducible and fast, but carries no audio track.'],
  'ad-render-audio': ['Render (with audio)', 'Real-time capture with the track mixed in. This is the version to hand a client. Not reproducible, because it follows a live clock.'],
  'ad-poster': ['Poster frame', 'A matching still at the current scrub position, for static placements.'],
  'ad-scrub': ['Scrub', 'Preview any moment in the spot without rendering it.']
};

// ---------------------------------------------------------------------------
export class HelpLayer {
  constructor({ toastFn } = {}) {
    this.active = false;
    this.toast = toastFn;
    this._buildPopover();
    this._bind();
    this.apply();
  }

  _buildPopover() {
    const el = document.createElement('div');
    el.id = 'helpPop';
    el.setAttribute('role', 'tooltip');
    el.innerHTML = '<b></b><p></p>';
    document.body.appendChild(el);
    this.pop = el;
    el.addEventListener('click', () => this.hide());
  }

  /** Attach title + accessible label to everything with a data-help key. */
  apply() {
    document.querySelectorAll('[data-help]').forEach(el => {
      const entry = HELP[el.dataset.help];
      if (!entry) return;
      const [title, body] = entry;
      el.setAttribute('title', `${title} — ${body}`);
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', title);
    });
  }

  _bind() {
    let timer = null, movedFrom = null, suppressClick = false;

    const findTarget = (e) => e.target.closest('[data-help]');

    document.addEventListener('pointerdown', (e) => {
      const t = findTarget(e);
      if (!t) return;
      movedFrom = [e.clientX, e.clientY];
      // help mode: single tap explains instead of activating
      if (this.active) { suppressClick = true; return; }
      timer = setTimeout(() => {
        timer = null;
        suppressClick = true;
        this.show(t);
      }, 450);
    }, true);

    document.addEventListener('pointermove', (e) => {
      if (!timer || !movedFrom) return;
      if (Math.hypot(e.clientX - movedFrom[0], e.clientY - movedFrom[1]) > 10) {
        clearTimeout(timer); timer = null;      // it's a drag, not a hold
      }
    }, true);

    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    document.addEventListener('pointerup', clear, true);
    document.addEventListener('pointercancel', clear, true);

    // in help mode, swallow the activation and explain instead
    document.addEventListener('click', (e) => {
      const t = findTarget(e);
      if (!t) return;
      if (this.active) {
        e.preventDefault(); e.stopPropagation();
        this.show(t);
        return;
      }
      if (suppressClick) {
        e.preventDefault(); e.stopPropagation();
        suppressClick = false;
      }
    }, true);

    // desktop hover — styled popover in addition to the native title
    let hoverTimer = null;
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const t = findTarget(e);
      if (!t) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => this.show(t, true), 380);
    });
    document.addEventListener('pointerout', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(hoverTimer);
      if (this._hoverShown) this.hide();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
      if (e.key === '?') this.toggle();
    });
  }

  show(el, isHover = false) {
    const entry = HELP[el.dataset.help];
    if (!entry) return;
    const [title, body] = entry;
    this.pop.querySelector('b').textContent = title;
    this.pop.querySelector('p').textContent = body;
    this.pop.classList.add('on');
    this._hoverShown = isHover;

    const r = el.getBoundingClientRect();
    this.pop.style.visibility = 'hidden';
    this.pop.style.left = '0px';
    this.pop.style.top = '0px';
    const pr = this.pop.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(10, Math.min(left, innerWidth - pr.width - 10));
    let top = r.top - pr.height - 10;
    if (top < 10) top = r.bottom + 10;
    this.pop.style.left = left + 'px';
    this.pop.style.top = top + 'px';
    this.pop.style.visibility = 'visible';

    clearTimeout(this._hideTimer);
    if (!isHover) this._hideTimer = setTimeout(() => this.hide(), 5200);
  }

  hide() {
    this.pop.classList.remove('on');
    this._hoverShown = false;
  }

  toggle() {
    this.active = !this.active;
    document.body.classList.toggle('help-mode', this.active);
    const btn = document.getElementById('helpBtn');
    if (btn) btn.classList.toggle('on', this.active);
    this.hide();
    if (this.toast) {
      this.toast(this.active
        ? 'Help mode on — tap anything to learn what it does'
        : 'Help mode off');
    }
  }
}
