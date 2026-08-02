/**
 * lokLiquid — app shell
 * Wires the solver, object layer, capture and share into one tool surface.
 */
import LokFluid, { PRESETS } from './core/lok-fluid.js';
import { ObjectLayer, LokObject, SYMBOL_NAMES, smoothPath, shouldClose,
         INTERACTIONS, INTERACTION_KEYS } from './core/objects.js';
import { HelpLayer } from './core/help.js';
import { Capture, shareBlob, downloadBlob, canShareFiles, checkSize,
         SHARE_PRESETS, buildShareLink, readShareLink } from './core/capture.js';
import { VideoExporter, videoSupported, pickMimeType } from './core/video.js';
import { exportPlotterSVG } from './core/plotter.js';
import { importAny } from './core/import.js';
import { AudioDriver, audioSupported, estimateTempo } from './core/audio.js';
import { BrandKit, listBrands, saveBrand, deleteBrand } from './core/brand.js';
import { AdComposer, TEMPLATES, TEMPLATE_KEYS } from './core/ad.js';
import { AdRenderer, analyzeTrack } from './core/ad-renderer.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const stage = $('#stage');
const fluidCanvas = $('#fluid');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');

const probe = LokFluid.probe();
if (!probe.ok) {
  const box = $('#unsupported');
  box.hidden = false;
  const inApp = /(FBAN|FBAV|Instagram|Line|Twitter|LinkedIn|Snapchat|Claude|WebView)/i.test(navigator.userAgent)
    || (/iPhone|iPad/.test(navigator.userAgent) && !/Safari/.test(navigator.userAgent));
  const msgs = {
    'no-webgl': 'This browser has WebGL switched off.',
    'webgl1-only': 'This browser only has WebGL1. lokLiquid needs WebGL2.',
    'no-context': 'Could not create a graphics context.',
    'no-float-target': 'This GPU/driver will not give us a float render target.'
  };
  $('#unsupportedMsg').textContent = msgs[probe.reason] || 'Graphics unavailable.';
  $('#unsupportedHint').innerHTML = inApp
    ? 'You are in an <b>in-app browser</b>, which blocks WebGL2.<br>' +
      'Tap <b>&hellip;</b> &rarr; <b>Open in Safari</b> (or Chrome) and it will run.'
    : 'Try Safari 15+, Chrome, or Firefox on a recent device.';
  $('#unsupportedDetail').textContent = `${probe.reason} — ${probe.detail}`;
  throw new Error('lokLiquid unsupported: ' + probe.reason);
}

const shared = readShareLink();

const fluid = new LokFluid(fluidCanvas, {
  seed: shared?.f?.seed ?? 7,
  ambient: reduced ? 0.2 : 0.7,
  reducedMotion: reduced,
  ...(shared?.f || {})
});

const layer = new ObjectLayer({ maskWidth: 512, maskHeight: 512, maxReactive: 12 });
fluid.setMaskSource(layer.maskCanvas);

const capture = new Capture(fluid, layer);

if (shared?.o) {
  layer.loadJSON(shared.o.map(o => ({
    kind: o.k, symbol: o.s, points: o.p, closed: o.c, text: o.t,
    transform: o.tr, reactive: o.r, visible: o.vi, mode: o.m, opacity: o.op
  })));
}

// seed some initial motion so the canvas isn't empty
function seedMotion() {
  const r = fluid.rng;
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2;
    fluid.splat(r(), r(), Math.cos(a) * 900, Math.sin(a) * 900);
  }
}
seedMotion();
fluid.start();

// ---------------------------------------------------------------------------
// overlay render loop (objects drawn on a 2D canvas above the fluid)
// ---------------------------------------------------------------------------
function sizeOverlay() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.floor(stage.clientWidth * dpr);
  const h = Math.floor(stage.clientHeight * dpr);
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w; overlay.height = h;
    layer.invalidate();
  }
}

let overlayDirty = true;
function drawOverlay() {
  sizeOverlay();
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);

  // objects
  const objCanvas = layer.renderDisplay(w, h);
  octx.drawImage(objCanvas, 0, 0);

  // live pen stroke
  if (pen.active && pen.points.length > 1) {
    octx.save();
    octx.strokeStyle = '#EDE9E3';
    octx.lineWidth = Math.max(1.5, 0.008 * Math.min(w, h));
    octx.lineJoin = octx.lineCap = 'round';
    octx.setLineDash([6, 6]);
    octx.beginPath();
    octx.moveTo(pen.points[0][0] * w, pen.points[0][1] * h);
    for (const p of pen.points.slice(1)) octx.lineTo(p[0] * w, p[1] * h);
    octx.stroke();
    octx.restore();
  }

  // selection ring
  if (selected) {
    const t = selected.transform;
    const size = Math.min(w, h) * t.scale;
    octx.save();
    octx.strokeStyle = 'rgba(237,233,227,.5)';
    octx.setLineDash([4, 5]);
    octx.lineWidth = 1.5;
    octx.strokeRect(t.x * w - size / 2, t.y * h - size / 2, size, size);
    octx.restore();
  }
}

function overlayLoop() {
  if (layer.dirty) {
    layer.renderMask();
    layer.renderDisplay(overlay.width, overlay.height);
    layer.dirty = false;
    fluid.invalidateMask();
  }
  drawOverlay();
  requestAnimationFrame(overlayLoop);
}
requestAnimationFrame(overlayLoop);

// mask sync — dirty-flagged, one flag drives mask + display together
// driven from the overlay loop below — no polling lag

// ---------------------------------------------------------------------------
// interaction: draw | pen | move
// ---------------------------------------------------------------------------
let mode = 'draw';
let selected = null;
const pen = { active: false, points: [] };
let last = null;
let dragging = null;
const activePointers = new Map();

function norm(e) {
  const r = stage.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}

stage.addEventListener('pointerdown', (e) => {
  activePointers.set(e.pointerId, e);
  if (activePointers.size > 1) { last = null; pen.active = false; return; }  // palm/multi-touch guard
  stage.setPointerCapture(e.pointerId);
  const [nx, ny] = norm(e);

  if (mode === 'pen') {
    pen.active = true;
    pen.points = [[nx, ny]];
    return;
  }
  if (mode === 'move') {
    const hit = layer.hitTest(nx, ny, overlay.width, overlay.height);
    selected = hit;
    renderLayers();
    if (hit) { dragging = { obj: hit, ox: nx - hit.transform.x, oy: ny - hit.transform.y }; return; }
  }
  last = [e.clientX, e.clientY];
});

stage.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, e);
  if (activePointers.size > 1) return;
  const [nx, ny] = norm(e);

  if (pen.active) {
    const lastPt = pen.points[pen.points.length - 1];
    if (Math.hypot(nx - lastPt[0], ny - lastPt[1]) > 0.008) pen.points.push([nx, ny]);
    return;
  }
  if (dragging) {
    dragging.obj.transform.x = nx - dragging.ox;
    dragging.obj.transform.y = ny - dragging.oy;
    layer.invalidate();
    return;
  }
  if (last && mode === 'draw') {
    fluid.stroke(e.clientX, e.clientY, last[0], last[1]);
    last = [e.clientX, e.clientY];
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (pen.active) {
    pen.active = false;
    if (pen.points.length > 3) {
      const closed = shouldClose(pen.points);
      const pts = smoothPath(pen.points);
      if (closed) pts.push(pts[0]);
      const po = layer.add(new LokObject({ kind: 'pen', points: pts, closed, mode: 'deflect' }));
      selected = po;
      renderLayers();
    }
    pen.points = [];
  }
  dragging = null;
  last = null;   // pointercancel handled identically — no stale stroke
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
addEventListener('blur', () => { activePointers.clear(); last = null; dragging = null; });

addEventListener('resize', () => { fluid.resize(); sizeOverlay(); layer.invalidate(); });
if (window.visualViewport) {
  visualViewport.addEventListener('resize', () => { fluid.resize(); sizeOverlay(); });
}

// battery/thermal: pause when hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) fluid.pause(); else fluid.resume();
});

// ---------------------------------------------------------------------------
// UI: mode buttons
// ---------------------------------------------------------------------------
$$('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    $$('[data-mode]').forEach(b => b.classList.toggle('on', b === btn));
    if (mode !== 'move') { selected = null; renderLayers(); }
  });
});

// presets
$$('[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    fluid.applyPreset(btn.dataset.preset);
    $$('[data-preset]').forEach(b => b.classList.toggle('on', b === btn));
    syncSliders();
  });
});

// sliders
function bindSlider(id, key, scale = 1, fmt = (v) => v.toFixed(2)) {
  const el = $('#' + id), out = $('#' + id + 'v');
  el.addEventListener('input', () => {
    const v = +el.value * scale;
    fluid.set(key, v);
    out.textContent = fmt(v);
  });
}
bindSlider('curl', 'curl', 1, v => v.toFixed(0));
bindSlider('fade', 'densityDissipation', 0.1);
bindSlider('radius', 'splatRadius', 0.01);

function syncSliders() {
  $('#curl').value = fluid.config.curl;
  $('#curlv').textContent = fluid.config.curl.toFixed(0);
  $('#fade').value = fluid.config.densityDissipation * 10;
  $('#fadev').textContent = fluid.config.densityDissipation.toFixed(2);
  $('#radius').value = fluid.config.splatRadius * 100;
  $('#radiusv').textContent = fluid.config.splatRadius.toFixed(2);
}
syncSliders();

// ---------------------------------------------------------------------------
// symbol picker
// ---------------------------------------------------------------------------
const symbolGrid = $('#symbolGrid');
SYMBOL_NAMES.forEach(name => {
  const b = document.createElement('button');
  b.className = 'sym';
  b.textContent = name;
  b.addEventListener('click', () => {
    const o = layer.add(new LokObject({
      kind: 'symbol', symbol: name,
      transform: { x: 0.5, y: 0.42, scale: 0.28, rotation: 0 },
      mode: 'deflect'
    }));
    selected = o;
    closeSheets();
    mode = 'move';
    $$('[data-mode]').forEach(b2 => b2.classList.toggle('on', b2.dataset.mode === 'move'));
    renderLayers();
  });
  symbolGrid.appendChild(b);
});

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------
const FONTS = [
  { label: 'Grotesk', css: '600 120px "Inter", system-ui, sans-serif' },
  { label: 'Serif',   css: '600 120px "Georgia", "Times New Roman", serif' },
  { label: 'Mono',    css: '600 120px ui-monospace, "SF Mono", Menlo, monospace' },
  { label: 'Condensed', css: '700 120px "Arial Narrow", "Helvetica Neue", sans-serif' }
];
let pendingFont = FONTS[0].css;

const fontRow = $('#fontRow');
FONTS.forEach((f, i) => {
  const b = document.createElement('button');
  b.className = 'chip' + (i === 0 ? ' on' : '');
  b.textContent = f.label;
  b.style.fontFamily = f.css.split('px ')[1];
  b.addEventListener('click', () => {
    pendingFont = f.css;
    Array.from(fontRow.children).forEach(c => c.classList.toggle('on', c === b));
    if (selected && selected.kind === 'text') { selected.font = f.css; layer.invalidate(); }
  });
  fontRow.appendChild(b);
});

$('#addText').addEventListener('click', async () => {
  const value = $('#textInput').value.trim();
  if (!value) return;
  if (document.fonts && document.fonts.ready) await document.fonts.ready;  // race guard
  const o = layer.add(new LokObject({
    kind: 'text', text: value, font: pendingFont,
    transform: { x: 0.5, y: 0.4, scale: 0.14, rotation: 0 },
    reactive: true, mode: 'deflect', fill: '#EDE9E3'
  }));
  selected = o;
  $('#textInput').value = '';
  closeSheets();
  mode = 'move';
  $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === 'move'));
  renderLayers();
});

// ---------------------------------------------------------------------------
// layers panel
// ---------------------------------------------------------------------------
const layersList = $('#layersList');
function syncObjSliders() {
  const has = !!selected;
  ['objScale','objRotate','objOpacity'].forEach(id => { $('#'+id).disabled = !has; });
  if (!has) return;
  $('#objScale').value = Math.round(selected.transform.scale * 100);
  $('#objRotate').value = Math.round((selected.transform.rotation * 180) / Math.PI);
  $('#objOpacity').value = Math.round(selected.opacity * 100);
}

function renderLayers() {
  syncObjSliders();
  if (typeof syncInteraction === 'function') syncInteraction();
  layersList.innerHTML = '';
  if (!layer.objects.length) {
    layersList.innerHTML = '<div class="empty">No objects yet. Add a symbol, draw with the pen, or place text.</div>';
    return;
  }
  [...layer.objects].reverse().forEach((o) => {
    const row = document.createElement('div');
    row.className = 'layer' + (selected === o ? ' sel' : '');
    row.innerHTML = `
      <button class="dot ${o.reactive ? 'on' : ''}" data-help="reactive-dot"></button>
      <button class="eye ${o.visible ? 'on' : ''}" data-help="visible-eye">${o.visible ? '◉' : '○'}</button>
      <span class="name">${o.label}</span>
      <select class="mode">
        <option value="deflect"${o.mode==='deflect'?' selected':''}>deflect</option>
        <option value="absorb"${o.mode==='absorb'?' selected':''}${!o.hasInterior?' disabled':''}>absorb</option>
        <option value="attract"${o.mode==='attract'?' selected':''}>attract</option>
      </select>
      <button class="del">✕</button>`;
    row.querySelector('.dot').onclick = () => { o.reactive = !o.reactive; layer.invalidate(); renderLayers(); };
    row.querySelector('.eye').onclick = () => { o.visible = !o.visible; layer.invalidate(); renderLayers(); };
    row.querySelector('.mode').onchange = (e) => { o.mode = e.target.value; layer.invalidate(); };
    row.querySelector('.del').onclick = () => { layer.remove(o.id); if (selected===o) selected=null; renderLayers(); };
    row.querySelector('.name').onclick = () => { selected = o; renderLayers(); };
    layersList.appendChild(row);
  });
  const count = layer.objects.filter(o => o.reactive).length;
  $('#reactiveCount').textContent = `${Math.min(count, layer.maxReactive)}/${layer.maxReactive} reactive`;
}
renderLayers();

// scale/rotate for selected
$('#objScale').addEventListener('input', (e) => {
  if (!selected) return;
  selected.transform.scale = +e.target.value / 100;
  layer.invalidate();
});
$('#objRotate').addEventListener('input', (e) => {
  if (!selected) return;
  selected.transform.rotation = (+e.target.value / 180) * Math.PI;
  layer.invalidate();
});
$('#objOpacity').addEventListener('input', (e) => {
  if (!selected) return;
  selected.opacity = +e.target.value / 100;
  layer.invalidate();
});

// ---------------------------------------------------------------------------
// interaction presets — how object and fluid meet
// ---------------------------------------------------------------------------
const interactionRow = $('#interactionRow');
INTERACTION_KEYS.forEach(k => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = INTERACTIONS[k].label;
  b.dataset.interaction = k;
  b.onclick = () => {
    if (!selected) { toast('Select an object first'); return; }
    selected.applyInteraction(k);
    layer.invalidate();
    syncInteraction();
    renderLayers();
  };
  interactionRow.appendChild(b);
});

function syncInteraction() {
  const has = !!selected;
  $('#objStrength').disabled = !has;
  Array.from(interactionRow.children).forEach(c =>
    c.classList.toggle('on', has && selected.interaction === c.dataset.interaction));
  if (!has) {
    $('#interactionBlurb').textContent = 'Select an object to change how it meets the fluid.';
    return;
  }
  $('#objStrength').value = Math.round(selected.strength * 100);
  $('#objStrengthV').textContent = Math.round(selected.strength * 100) + '%';
  const key = selected.interaction;
  $('#interactionBlurb').textContent = key && INTERACTIONS[key]
    ? INTERACTIONS[key].blurb
    : `Custom — ${selected.mode}, ${Math.round(selected.strength * 100)}% strength.`;
}

$('#objStrength').addEventListener('input', (e) => {
  if (!selected) return;
  selected.strength = +e.target.value / 100;
  selected.interaction = null;              // now custom, not a preset
  $('#objStrengthV').textContent = e.target.value + '%';
  layer.invalidate();
  syncInteraction();
});

$('#fluidSlip').addEventListener('input', (e) => {
  const v = +e.target.value / 100;
  fluid.set('slip', v);
  $('#fluidSlipV').textContent = e.target.value + '%';
});

// ---------------------------------------------------------------------------
// studio: capture + gallery
// ---------------------------------------------------------------------------
const galleryGrid = $('#galleryGrid');
let galleryFrames = [];

$('#snapBtn').addEventListener('click', async () => {
  const preset = $('#exportPreset').value;
  const f = await capture.snapshot(preset);
  galleryFrames.unshift(f);
  renderGallery();
  openSheet('gallery');
});

$('#renderBtn').addEventListener('click', async () => {
  const preset = $('#exportPreset').value;
  const count = +$('#frameCount').value;
  const btn = $('#renderBtn');
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    const frames = await capture.renderSequence({
      frames: count, stride: Math.max(1, Math.round(count / 24)), preset,
      onProgress: (p) => { btn.textContent = `Rendering ${Math.round(p * 100)}%`; }
    });
    galleryFrames = frames.slice().reverse().concat(galleryFrames);
    renderGallery();
    openSheet('gallery');
  } catch (err) {
    alert('Render failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Render sequence';
  }
});

function renderGallery() {
  galleryGrid.innerHTML = '';
  if (!galleryFrames.length) {
    galleryGrid.innerHTML = '<div class="empty">No frames captured yet.</div>';
    return;
  }
  galleryFrames.forEach((fr, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<img src="${fr.url}" alt="frame ${fr.index}">
      <div class="cellbar"><span>f${String(fr.index).padStart(3,'0')}</span>
      <button class="mini save">Save</button><button class="mini post">Post</button></div>`;
    cell.querySelector('.save').onclick = () =>
      downloadBlob(fr.blob, `lokliquid-${fr.index}.png`);
    cell.querySelector('.post').onclick = async () => {
      const preset = $('#exportPreset').value;
      const size = checkSize(fr.blob, preset);
      if (!size.ok) { alert(size.message); return; }
      await shareBlob(fr.blob, `lokliquid-${fr.index}.png`, 'Made with lokLiquid');
    };
    galleryGrid.appendChild(cell);
  });
}
renderGallery();

// export preset options
const presetSel = $('#exportPreset');
Object.entries(SHARE_PRESETS).forEach(([k, v]) => {
  const opt = document.createElement('option');
  opt.value = k; opt.textContent = v.label;
  if (k === 'square') opt.selected = true;
  presetSel.appendChild(opt);
});

if (!canShareFiles()) $('#shareNote').hidden = false;

// ---------------------------------------------------------------------------
// seed link
// ---------------------------------------------------------------------------
$('#copyLink').addEventListener('click', async () => {
  const link = buildShareLink(fluid, layer);
  try {
    await navigator.clipboard.writeText(link);
    toast('Motion link copied — regenerates exactly on any device');
  } catch {
    prompt('Copy this motion link:', link);
  }
});

$('#reseed').addEventListener('click', () => {
  fluid.set('seed', Math.floor(Math.random() * 1e6));
  fluid.reset();
  seedMotion();
  updateStatus();
});

$('#playBtn').addEventListener('click', () => {
  if (fluid._running) { fluid.stop(); $('#playBtn').textContent = 'Play'; }
  else { fluid.start(); $('#playBtn').textContent = 'Pause'; }
});

$('#stepBtn').addEventListener('click', () => {
  fluid.stop();
  $('#playBtn').textContent = 'Play';
  fluid.stepFrame();
  updateStatus();
});

$('#clearBtn').addEventListener('click', () => {
  fluid.reset();
  seedMotion();
});

// ---------------------------------------------------------------------------
// sheets
// ---------------------------------------------------------------------------
function openSheet(name) {
  $$('.sheet').forEach(s => s.classList.toggle('open', s.dataset.sheet === name));
  $('#scrim').classList.toggle('on', !!name);
}
function closeSheets() {
  $$('.sheet').forEach(s => s.classList.remove('open'));
  $('#scrim').classList.remove('on');
}
$$('[data-open]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.open)));
$('#openGallery').addEventListener('click', () => openSheet('gallery'));
$$('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
$('#scrim').addEventListener('click', closeSheets);

// ---------------------------------------------------------------------------
function updateStatus() {
  $('#status').textContent = `f${String(fluid.frame).padStart(4, '0')} · seed ${fluid.config.seed}`;
}
setInterval(updateStatus, 120);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2400);
}

// brand strip
const BRANDS = [
  { name: 'LOK MOTION', tag: 'design systems in motion' },
  { name: 'LOKBOOK', tag: 'thin-line plotter work' },
  { name: 'LOK STUDIO', tag: 'export · post · share' },
  { name: 'SOFT CURRENT', tag: 'audiovisual ambient' }
];
let brandIdx = 0;
const brandEl = $('#brand');
function cycleBrand() {
  const b = BRANDS[brandIdx % BRANDS.length];
  brandEl.style.opacity = 0;
  setTimeout(() => {
    brandEl.innerHTML = `<b>${b.name}</b><span>${b.tag}</span>`;
    brandEl.style.opacity = 1;
  }, reduced ? 0 : 260);
  brandIdx++;
}
cycleBrand();
setInterval(cycleBrand, 5200);

// ---------------------------------------------------------------------------
// video export
// ---------------------------------------------------------------------------
const video = new VideoExporter(fluid, layer);
let recording = false;

if (!videoSupported()) {
  $('#videoBtn').disabled = true;
  $('#videoNote').textContent = 'Video recording is unavailable in this browser — use Render sequence for frames.';
} else {
  $('#videoNote').textContent = 'Records as ' +
    (pickMimeType().includes('mp4') ? 'MP4' : 'WebM') + ', rendered offline from the seed.';
}

$('#videoBtn').addEventListener('click', async () => {
  const btn = $('#videoBtn');
  if (recording) { video.cancel(); btn.textContent = 'Cancelling…'; return; }
  const preset = $('#exportPreset').value;
  const seconds = +$('#videoSeconds').value;
  recording = true;
  btn.textContent = 'Recording 0%';
  try {
    const { blob, ext } = await video.record({
      seconds, preset, fps: 30,
      onProgress: (p) => { btn.textContent = `Recording ${Math.round(p * 100)}%`; }
    });
    const size = checkSize(blob, preset);
    if (!size.ok) toast(size.message);
    const name = `lokliquid-${fluid.config.seed}.${ext}`;
    const res = await shareBlob(blob, name, 'Made with lokLiquid');
    toast(res === 'downloaded' ? 'Saved ' + name : 'Shared ' + name);
  } catch (err) {
    toast('Video failed: ' + err.message);
  } finally {
    recording = false;
    btn.textContent = 'Record video';
  }
});

// ---------------------------------------------------------------------------
// plotter / SVG export
// ---------------------------------------------------------------------------
$('#svgBtn').addEventListener('click', () => {
  try {
    const blob = exportPlotterSVG(fluid, layer, {
      count: +$('#svgDensity').value,
      steps: 140,
      widthMm: 210, heightMm: 297,
      strokeMm: 0.35,
      pens: ['#111111'],
      title: 'lokLiquid seed ' + fluid.config.seed
    });
    downloadBlob(blob, `lokliquid-${fluid.config.seed}-plot.svg`);
    toast('Plotter SVG saved — stroke paths, no raster');
  } catch (err) {
    toast('SVG failed: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// import: SVG / raster
// ---------------------------------------------------------------------------
$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#importStatus');
  status.textContent = 'Importing…';
  try {
    const threshold = +$('#importThreshold').value / 100;
    const { object } = await importAny(file, { threshold });
    const o = layer.add(object);
    selected = o;
    mode = 'move';
    $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === 'move'));
    closeSheets();
    renderLayers();
    status.textContent = '';
    toast(`Imported ${file.name} — drag to place, tune in Layers`);
  } catch (err) {
    status.textContent = err.message;
  }
});
$('#importThreshold').addEventListener('input', (e) => {
  $('#importThresholdV').textContent = e.target.value + '%';
});

// ---------------------------------------------------------------------------
// audio-reactive auto-motion
// ---------------------------------------------------------------------------
const audio = new AudioDriver(fluid, layer);
let audioLoaded = false;

if (!audioSupported()) {
  $$('#auto button').forEach(b => b.disabled = true);
  $('#audioStatus').textContent = 'Web Audio is unavailable in this browser.';
}

$('#audioFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#audioStatus');
  status.textContent = 'Loading…';
  try {
    await audio.loadFile(file);
    audioLoaded = true;
    status.textContent = `Loaded ${file.name}`;
    $('#audioPlay').disabled = false;
    try {
      const buf = await file.arrayBuffer();
      const bpm = await estimateTempo(buf);
      $('#audioBpm').textContent = `~${bpm} BPM`;
    } catch { $('#audioBpm').textContent = ''; }
  } catch (err) {
    status.textContent = err.message;
  }
});

$('#audioUrlGo').addEventListener('click', async () => {
  const url = $('#audioUrl').value.trim();
  if (!url) return;
  const status = $('#audioStatus');
  status.textContent = 'Loading…';
  try {
    await audio.loadURL(url);
    audioLoaded = true;
    status.textContent = 'Loaded from link';
    $('#audioPlay').disabled = false;
  } catch (err) {
    status.textContent = err.message;
  }
});

$('#audioPlay').addEventListener('click', async () => {
  if (!audioLoaded) return;
  if (audio.running) {
    audio.pause();
    $('#audioPlay').textContent = 'Play & drive fluid';
  } else {
    await audio.play();
    $('#audioPlay').textContent = 'Pause';
    toast('Audio is now driving the fluid — curl, splats and reveals follow the mix');
  }
});

$('#audioStop').addEventListener('click', () => {
  audio.stop();
  audioLoaded = false;
  $('#audioPlay').textContent = 'Play & drive fluid';
  $('#audioPlay').disabled = true;
  $('#audioStatus').textContent = '';
  $('#audioBpm').textContent = '';
});

// auto-record: play the track and capture video for its duration (capped)
$('#audioAutoRender').addEventListener('click', async () => {
  if (!audioLoaded) { toast('Load audio first'); return; }
  const btn = $('#audioAutoRender');
  const seconds = Math.min(20, audio.duration || 8);
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    if (!audio.running) await audio.play();
    // audio-driven motion is live, not seed-reproducible — capture what's
    // actually on screen in real time, not an offline regeneration
    const { blob, ext } = await video.recordLive({
      seconds, fps: 30,
      onProgress: (p) => { btn.textContent = `Rendering ${Math.round(p*100)}%`; }
    });
    const name = `lokliquid-auto-${fluid.config.seed}.${ext}`;
    const res = await shareBlob(blob, name, 'Made with lokLiquid — audio-driven');
    toast(res === 'downloaded' ? 'Saved ' + name : 'Shared ' + name);
  } catch (err) {
    toast('Auto-render failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Auto-render video from track';
  }
});

// ===========================================================================
// AD STUDIO — the client-facing flow
// ===========================================================================
let brand = new BrandKit({ name: '' });
let composer = new AdComposer(brand, { template: 'drop-reveal', durationSec: 10, bpm: 120 });
let adRenderer = new AdRenderer(fluid, layer, brand, composer);
let trackFile = null;
let timeline = null;
let adAudioEl = null;

function refreshRenderer() {
  adRenderer.brand = brand;
  adRenderer.composer = composer;
  composer.brand = brand;
  composer.rebuild();
}

// --- step 1: brand ---------------------------------------------------------
$('#brandName').addEventListener('input', (e) => {
  brand.name = e.target.value;
  refreshRenderer();
});
['brandHeadline','brandSubline','brandCta','brandUrl'].forEach(id => {
  const key = id.replace('brand','').toLowerCase();
  $('#'+id).addEventListener('input', (e) => {
    brand[key === 'headline' ? 'headline' : key === 'subline' ? 'subline'
      : key === 'cta' ? 'cta' : 'url'] = e.target.value;
    refreshRenderer();
    renderAdPreview();
  });
});

$('#brandLogo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#brandStatus');
  status.textContent = 'Reading logo…';
  try {
    await brand.setLogo(file);
    brand.applyToFluid(fluid);
    fluid.reset();
    seedMotion();
    renderSwatches();
    refreshRenderer();
    renderAdPreview();
    status.textContent = 'Logo loaded — palette pulled from your mark';
  } catch (err) {
    status.textContent = err.message;
  }
});

function renderSwatches() {
  const row = $('#swatches');
  row.innerHTML = '';
  (brand.palette || []).forEach(hex => {
    const d = document.createElement('div');
    d.className = 'swatch';
    d.style.background = hex;
    d.title = hex;
    d.onclick = () => { brand.accent = hex; refreshRenderer(); renderAdPreview(); toast('Accent set ' + hex); };
    row.appendChild(d);
  });
  if (brand.logo) {
    const img = $('#logoPreview');
    img.src = brand.logo.dataUrl;
    img.hidden = false;
  }
}

// --- step 2: track ---------------------------------------------------------
$('#adTrack').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  trackFile = file;
  const status = $('#adTrackStatus');
  status.textContent = 'Analyzing track…';
  try {
    const buf = await file.arrayBuffer();
    timeline = await analyzeTrack(buf, { fps: 60, maxSeconds: 60 });
    composer.bpm = timeline.bpm;
    composer.duration = Math.min(timeline.duration, +$('#adDuration').value);
    refreshRenderer();
    status.textContent = `${file.name} — ${timeline.bpm} BPM, ${timeline.duration.toFixed(1)}s`;
    $('#adRenderBtn').disabled = false;
    $('#adRenderAudioBtn').disabled = false;

    // element for the audio-muxed path
    if (adAudioEl) { adAudioEl.pause(); adAudioEl.src = ''; }
    adAudioEl = new Audio(URL.createObjectURL(file));
    adAudioEl.preload = 'auto';
    renderAdPreview();
  } catch (err) {
    status.textContent = 'Could not analyze: ' + err.message;
  }
});

// --- step 3: template ------------------------------------------------------
const tplRow = $('#templateRow');
TEMPLATE_KEYS.forEach((k, i) => {
  const b = document.createElement('button');
  b.className = 'chip' + (k === 'drop-reveal' ? ' on' : '');
  b.textContent = TEMPLATES[k].label;
  b.onclick = () => {
    composer.set('template', k);
    Array.from(tplRow.children).forEach(c => c.classList.toggle('on', c === b));
    $('#templateBlurb').textContent = TEMPLATES[k].blurb;
    renderAdPreview();
  };
  tplRow.appendChild(b);
});
$('#templateBlurb').textContent = TEMPLATES['drop-reveal'].blurb;

$('#adDuration').addEventListener('input', (e) => {
  const v = +e.target.value;
  $('#adDurationV').textContent = v + 's';
  composer.set('durationSec', timeline ? Math.min(timeline.duration, v) : v);
  $('#adScrub').max = composer.duration;
  renderAdPreview();
});

$('#adScrub').addEventListener('input', () => renderAdPreview());

// --- preview ---------------------------------------------------------------
const previewCanvas = $('#adPreview');
const pctx = previewCanvas.getContext('2d');
async function renderAdPreview() {
  const spec = { w: 360, h: 640 };
  const fmt = $('#adFormat').value;
  if (fmt === 'instagram-feed' || fmt === 'square') { spec.w = 480; spec.h = 480; }
  else if (fmt === 'youtube') { spec.w = 640; spec.h = 360; }
  previewCanvas.width = spec.w; previewCanvas.height = spec.h;
  pctx.fillStyle = brand.background || '#0B0A09';
  pctx.fillRect(0, 0, spec.w, spec.h);
  // draw current fluid state scaled into the preview aspect
  const src = fluid.canvas;
  if (src.width) {
    const sr = src.width / src.height, tr = spec.w / spec.h;
    let sw, sh, sx, sy;
    if (sr > tr) { sh = src.height; sw = sh * tr; sx = (src.width - sw)/2; sy = 0; }
    else { sw = src.width; sh = sw / tr; sx = 0; sy = (src.height - sh)/2; }
    pctx.drawImage(src, sx, sy, sw, sh, 0, 0, spec.w, spec.h);
  }
  const t = +$('#adScrub').value;
  await composer.draw(pctx, spec.w, spec.h, t);
}
setInterval(() => { if ($('#adstudio').classList.contains('open')) renderAdPreview(); }, 220);

$('#adFormat').addEventListener('change', renderAdPreview);

// --- render ----------------------------------------------------------------
$('#adRenderBtn').addEventListener('click', async () => {
  const btn = $('#adRenderBtn');
  btn.disabled = true;
  try {
    const { blob, ext, silent } = await adRenderer.renderOffline({
      timeline,
      preset: $('#adFormat').value,
      fps: 30,
      onProgress: (p) => { btn.textContent = `Rendering ${Math.round(p*100)}%`; }
    });
    const name = `${(brand.name || 'lokliquid').replace(/\s+/g,'-').toLowerCase()}-ad.${ext}`;
    const res = await shareBlob(blob, name, brand.headline || '');
    toast(silent
      ? 'Rendered silent (deterministic) — use "with audio" for a version with sound'
      : (res === 'downloaded' ? 'Saved ' + name : 'Shared ' + name));
  } catch (err) {
    toast('Render failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Render ad (silent, exact)';
  }
});

$('#adRenderAudioBtn').addEventListener('click', async () => {
  const btn = $('#adRenderAudioBtn');
  if (!adAudioEl) { toast('Load a track first'); return; }
  btn.disabled = true;
  try {
    if (audio.running) audio.pause();     // free the element source
    const { blob, ext, silent } = await adRenderer.renderLiveWithAudio({
      audioEl: adAudioEl,
      preset: $('#adFormat').value,
      fps: 30,
      onProgress: (p) => { btn.textContent = `Recording ${Math.round(p*100)}%`; }
    });
    const name = `${(brand.name || 'lokliquid').replace(/\s+/g,'-').toLowerCase()}-ad-audio.${ext}`;
    await shareBlob(blob, name, brand.headline || '');
    if (silent) toast('Recorded, but without audio — the track source was already claimed');
    else toast('Rendered with audio: ' + name);
  } catch (err) {
    toast('Render failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Render ad (with audio)';
  }
});

$('#adPosterBtn').addEventListener('click', async () => {
  try {
    const blob = await adRenderer.poster({ t: +$('#adScrub').value, preset: $('#adFormat').value });
    downloadBlob(blob, `${(brand.name||'lokliquid').replace(/\s+/g,'-').toLowerCase()}-poster.png`);
    toast('Poster frame saved');
  } catch (err) { toast('Poster failed: ' + err.message); }
});

// --- brand save/load -------------------------------------------------------
function renderBrandList() {
  const list = $('#brandList');
  const all = listBrands();
  list.innerHTML = all.length ? '' : '<div class="empty">No saved brands yet.</div>';
  all.forEach(b => {
    const row = document.createElement('div');
    row.className = 'layer';
    row.innerHTML = `<span class="name">${b.name || 'Untitled'}</span>
      <button class="mini load">Load</button><button class="del">✕</button>`;
    row.querySelector('.load').onclick = () => {
      brand = new BrandKit(b.toJSON());
      brand.applyToFluid(fluid);
      fluid.reset(); seedMotion();
      $('#brandName').value = brand.name || '';
      $('#brandHeadline').value = brand.headline || '';
      $('#brandSubline').value = brand.subline || '';
      $('#brandCta').value = brand.cta || '';
      $('#brandUrl').value = brand.url || '';
      renderSwatches(); refreshRenderer(); renderAdPreview();
      toast('Loaded ' + (brand.name || 'brand'));
    };
    row.querySelector('.del').onclick = () => { deleteBrand(b.id); renderBrandList(); };
    list.appendChild(row);
  });
}

$('#brandSave').addEventListener('click', () => {
  brand.name = $('#brandName').value || brand.name || 'Untitled';
  const ok = saveBrand(brand);
  renderBrandList();
  toast(ok ? 'Brand saved on this device'
           : 'Could not save — logo may be too large for local storage');
});
renderBrandList();

// ---------------------------------------------------------------------------
// help — hover on desktop, long-press on touch, or tap the ? for help mode
// ---------------------------------------------------------------------------
const help = new HelpLayer({ toastFn: toast });
$('#helpBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  help.toggle();
});
// re-apply titles whenever new controls are generated
const _renderLayers = renderLayers;
renderLayers = function () { _renderLayers(); help.apply(); };
help.apply();

window.lok = { fluid, layer, capture, video, audio, brand, composer, adRenderer, help };
