# lokLiquid

Deterministic GPU fluid field with a collision-aware object system, studio
capture, and share-by-seed. Part of Lok-Motion.

## Run

Any static server (ES modules need one — `file://` won't work):

```
npx serve .
# or
python3 -m http.server 8080
```

`lokliquid.html` is a pre-bundled single-file build that opens with no server.

## Architecture

```
src/core/lok-fluid.js   solver — Stam stable fluids + vorticity confinement
src/core/objects.js     LokObject model, symbols, pen, text, mask rasterizer
src/core/capture.js     offline deterministic export, share presets, seed links
src/app.js              shell — gestures, layers, studio, brand strip
index.html              app
```

## Provenance

Clean-room. Written from Stam, *Stable Fluids* (SIGGRAPH 1999) and
Fedkiw/Stam/Jensen, *Visual Simulation of Smoke* (2001). No third-party source.
Ships proprietary.

## The moats

1. **Determinism as shareable state** — `{seed, config, objects}` reproduces a
   motion exactly, anywhere. Share ~200 bytes, not a video.
2. **One physics substrate** — symbols, pen shapes and text are the same
   `LokObject` and collide through the same mask. Text can ride the current.
3. **Reveal-through-motion** — an object can be invisible but reactive, so a
   hidden word is revealed only by how the fluid parts around it.

## Object model

Four independent states per object:

| State | Meaning |
|---|---|
| `visible` | drawn on screen |
| `reactive` | fluid collides with it |
| `mode` | `deflect` / `absorb` / `attract` |
| `locked` | can't be dragged |

Visible and reactive are independent — invisible-but-reactive is the reveal
trick; visible-but-inert is a plain overlay.

## Determinism contract

- Fixed timestep (`config.fps`), never wall-clock
- All ambient motion from a seeded mulberry32 PRNG
- `seek(t)` / `stepFrame()` reproduce any frame
- Export regenerates offline from the seed — it is not a screen recording

## Bug guards already in place

- `webglcontextlost` / `webglcontextrestored` rebuild
- Explicit `dispose()` of every FBO on resize/reseed (no GPU leak)
- `pointercancel` handled identically to `pointerup` (no stale stroke)
- Multi-touch guard so a resting palm doesn't draw
- `touch-action:none` + `overscroll-behavior:none` on stage AND body
- `document.fonts.ready` awaited before text placement (mask/display match)
- Single dirty flag drives mask + display together (never desync)
- Open pen paths fall back from `absorb` to `deflect` (no undefined interior)
- `navigator.canShare({files})` feature-detected, download fallback
- Capture snapshots/restores live state; `toBlob` always awaited
- Reactive object cap (12) to protect mobile GPUs
- `visibilitychange` pauses the sim (battery/thermal)

## Roadmap

v1.1 — swipe deck for multiple tools, WebM export via `MediaRecorder`,
full absorb/attract tuning, SVG stroke export for lokbook/plotter.
Later — MP4 via ffmpeg.wasm, audio-reactive mode, OAuth direct posting.

## v1.1 additions

- `src/core/video.js` — MediaRecorder export driven by the **offline** loop via
  `captureStream(0)` + `requestFrame()`, so a slow phone produces the same
  video as a fast one. MP4 on Safari 17+, WebM elsewhere.
- `src/core/plotter.js` — streamline tracing → Douglas-Peucker simplify →
  millimetre SVG with one `<g>` per pen. Plotter and riso ready, no raster.
- `src/shell/tool-contract.js` — `LokTool` interface plus `ToolDeck`, which
  destroys off-window contexts rather than hiding them (Safari evicts the
  oldest live WebGL context silently).

## Troubleshooting

**"lokLiquid needs WebGL2"** — almost always an in-app browser (Instagram,
Claude, Slack, Messenger webviews) which blocks WebGL2. Tap `…` → Open in
Safari. The unsupported screen now names the actual reason and prints the
driver string underneath.

## Ad Studio — client workflow

The client-facing path. Four steps, one sheet:

1. **Brand** — upload a logo (SVG or PNG). The palette is extracted from the
   mark via median-cut and fed straight into the fluid's dye, so the client's
   brand colours become the literal pigment in the water. Add headline,
   subline, CTA, URL. Save the kit to reuse across campaigns.
2. **Track** — upload the client's song. It's decoded once with
   `OfflineAudioContext`, and its band energies + beat grid are extracted as
   plain data (`analyzeTrack`). BPM is derived from the median inter-beat
   interval.
3. **Template** — five beat-synced layouts (`src/core/ad.js`). Cues snap to
   the detected beat so type lands *on* the beat rather than drifting.
4. **Deliver** — two export paths, labelled honestly:
   - **Silent, exact** — offline render driven by the extracted timeline.
     Reproducible, faster than realtime, no audio track.
   - **With audio** — real-time capture with the track muxed via
     `MediaStreamDestination`. Not reproducible, but has sound, which is what
     a client posts.
   - **Poster frame** — matching still for static placements.

### Why two export paths

`MediaRecorder` can mux audio, but only from a live stream. An offline render
runs faster than realtime and has no audio clock to sync to, so it can't carry
sound. Rather than silently shipping a mute "finished ad", both paths exist and
the UI names the tradeoff.

### Ad module map

```
src/core/brand.js       BrandKit, palette extraction, local persistence
src/core/ad.js          templates + AdComposer overlay renderer
src/core/ad-renderer.js analyzeTrack + offline/live render paths
```

## Help & discoverability

Explanations reach every platform, since hover doesn't exist on phones:

- **Desktop hover** — native `title` plus a styled popover after ~380ms
- **Touch long-press** — 450ms hold on any control (cancelled if you drag)
- **Help mode** — tap `?` in the top bar. Every explainable control gets a
  dashed marker and a single tap explains it instead of firing it.
- **Keyboard** — `?` toggles help mode, `Esc` dismisses

Copy lives in one map (`src/core/help.js`, `HELP`) rather than scattered
across `title` attributes, so wording stays consistent and is translatable
later. A build check verifies every `data-help` key in the markup has a
matching entry.

## Interaction model

How an object and the fluid affect each other is chosen by **behaviour**, not
by raw physics parameters:

| Preset | Feel |
|---|---|
| Rock | Hard edge, flow splits and races around |
| Stone | Softer obstacle, parts flow without snapping it |
| Sponge | Drinks the current, fluid pools against it |
| Magnet | Pulls flow inward, colour clings to the outline |
| Membrane | Barely there, nudges rather than blocks |
| Ghost | Visible but no physics at all |

Behind each preset: a collision `mode`, a `strength` (0–1, encoded into the
mask's blue channel and read per-pixel in the gradient pass), and a `rim`
thickness multiplier. Adjusting Strength directly switches the object to
"Custom" rather than silently diverging from the named preset.

**Slip** is global: how freely fluid slides along every edge. High slip glides
like glass, low slip drags like cloth. It's part of the share state, so a
motion link carries the interaction feel, not just the colours.
