# lokLiquid — Roadmap

Status snapshot: v1 core is built (solver, objects, studio, share, video,
plotter export). This document lays out what's shipped, what's next, and why,
so priority calls are easy to make later without re-litigating them.

**Repo integrity note:** the file transfer that landed this repo on GitHub
(see git history) scrambled every file's name against its content — a
21-way rotation, not data loss. It was found and fully restored (verified by
rebuilding `lokliquid.html` from the recovered `src/` tree and diffing
byte-for-byte against the previously committed bundle — zero diff). Nothing
was lost; the three modules with no standalone copy (`video.js`,
`plotter.js`, `src/shell/tool-contract.js`) were recovered from the inlined
bundle, which still had everything. Worth remembering if a future transfer
into this repo behaves oddly — verify filenames against content before
trusting a bulk copy/zip/transfer step.

Every item below is filtered through the three moats — if a feature doesn't
strengthen determinism-as-state, the shared physics substrate, or physical
output, it's a nice-to-have, not a priority.

---

## v1 — Shipped

The complete loop: draw → capture → export → share, single tool, no deck.

| Area | What's in |
|---|---|
| Solver | Stam stable fluids + vorticity confinement, fixed timestep, seeded PRNG, context-loss recovery, obstacle mask channel |
| Objects | Symbols (12), pen tool with auto-close, text-as-object, deflect/absorb/attract, 4 independent states (visible/reactive/mode/locked) |
| Studio | Offline deterministic frame capture, gallery, PNG export |
| Video | MediaRecorder fed from the offline loop — device-speed-independent output, MP4/WebM |
| Plotter | Streamline tracing → SVG, millimetre units, pen-separated groups |
| Share | `navigator.share()` with download fallback, seed-link (~200 byte motion state) |
| Shell | Canvas stability fixes, single-tool surface, brand strip |

**Known gaps in v1** (intentional, not bugs):
- Single tool only — no swipe deck live yet, though `ToolDeck` exists and is unused
- No OAuth posting (YouTube, scheduled posts) — share sheet only
- No audio-reactive mode
- No collaborative/multiplayer sessions
- Plotter export doesn't yet account for objects' actual mask geometry, only their transform boxes

---

## v1.1 — Deck & Polish (next up)

**Goal:** more than one tool live in the product, and the video/plotter paths
battle-tested on real devices rather than just in code review.

- **Wire `ToolDeck` into the shell.** It's built (`src/shell/tool-contract.js`)
  but nothing calls it yet. Needs: a second tool (even a placeholder) to prove
  the mount/destroy lifecycle under Safari's context cap, plus the edge-zone
  swipe gesture from the shell spec (two-finger or edge-only, since one-finger
  is claimed by drawing).
- **Brand strip → live JSON.** Currently hardcoded `BRANDS` array in
  `app.js`. Move to `public/brands.json` fetched with a short TTL so it
  updates without a redeploy, per the shell spec.
- **Object mask feeds plotter export.** Right now `toSVG()` draws objects
  from their transform box, not their actual rasterized mask — fine for
  symbols (they're simple paths anyway) but wrong for pen shapes with organic
  curves. Trace the mask canvas contour instead of re-deriving from `points`.
- **Device testing pass.** Everything above was built and syntax-verified but
  not run on physical hardware. Priority devices: iPhone Safari (context loss,
  touch gestures), older Android Chrome (float texture support varies more
  there than on iOS), iPad (different aspect ratio assumptions in `_dims()`).
- **Video export size/quality tuning.** `bitrate` is hardcoded to a 12–20Mbps
  range — verify against actual WhatsApp/Discord caps at real durations rather
  than the estimated `checkSize()` math.

---

## v1.2 — Second Tool

**Goal:** prove the shared physics substrate (moat #2) with a second tool that
reads the same velocity field, not just a second visual effect.

Candidate: **`LokFlowField`** (already scoped in the shell spec) — advects SVG
paths through the fluid's velocity field. This is the direct on-ramp to
lokbook, and it's the cheapest possible second tool because it doesn't need
its own solver — it reads `sampleVelocity()` from an existing `LokFluid`
instance.

- Define `LokFlowField` against the same `LokTool` contract
- Decide: does it share a solver instance with the fluid tool (cheaper, tighter
  coupling) or run its own (more isolated, doubles GPU cost)? Leaning shared —
  it's the whole point of the substrate.
- Deck now has a real second panel to test swipe/context-eviction against

---

## v1.3 — Object System Depth

Deferred from the original objects spec, now that the core model is proven:

- **Multi-emitter choreography** — timed/sequenced splats instead of only
  pointer-driven ones, so a designer can script an intro motion
- **Bounds modes** — currently the domain edge is always a hard wall; add
  wrap and open-edge modes
- **Color-from-image** — sample a palette from an uploaded photo instead of
  hand-picking one, feeds `config.palette`
- **Full layers panel** — reordering via drag (currently only `reorder()`
  exists in the model, no drag UI), lock toggle exposed in the panel (model
  supports `locked`, UI doesn't yet)
- **Attract/absorb tuning pass** — the two non-default collision modes work
  but haven't been tuned against real content; deflect is the one that's been
  visually verified

---

## v1.4 — Distribution

**Goal:** close the gap between "share sheet" and "actually posted."

- **YouTube OAuth posting** — separate milestone per the studio spec, needs
  Google OAuth + YouTube Data API, real backend token storage (not just
  client-side)
- **Scheduled/queued posts** — if usage shows people exporting in batches and
  posting later, a lightweight queue beats re-opening the share sheet each
  time
- Evaluate whether other platforms are worth direct OAuth vs. staying on
  `navigator.share()` — the moat isn't in posting mechanics, so don't over-invest
  here relative to the object system or a third tool

---

## v1.5 — Lok-Motion Integration

**Goal:** ship lokLiquid as a tool option inside
[Lok-Motion](https://github.com/mistachatty-cmyk/Lok-Motion) rather than only
as a standalone app. Not started, not scheduled ahead of v1.1–v1.4 — noted
here so the intent isn't lost between now and whenever it's picked up.

- The natural integration seam is already built: `src/shell/tool-contract.js`
  defines `LokTool` (mount/pause/resume/destroy/captureFrame/getShareState)
  specifically so a tool can live inside a host shell instead of owning the
  whole page. Lok-Motion is that host shell.
- Open question to resolve when this is scheduled: does Lok-Motion consume
  lokLiquid as a git submodule/npm package, or does lokLiquid's core get
  vendored in directly? The `lok-fluid` npm extraction (see SPINOFFS.md) is
  useful groundwork either way — do that first.
- Brand kit (`src/core/brand.js`) and Ad Studio were built client-facing and
  standalone; check whether Lok-Motion has its own brand/client model before
  wiring this in, rather than assuming lokLiquid's is authoritative.
- Depends on **v1.2**'s `ToolDeck` proving the mount/destroy lifecycle with a
  second tool first — don't wire a second *host* around `ToolDeck` before
  `ToolDeck` itself has been exercised once.

---

## Later / Unscheduled

Ideas worth keeping but not yet worth a milestone:

- **Digital/Y2K motion treatment, expanded.** v1 is live: a CRT scanline
  ambient + wordmark flicker on the WebGL2-unsupported status screen
  (`#unsupported` in `index.html`), reusing the scanline technique from
  Lok-Motion's component set (`lok-components.js`) with lokLiquid's own
  palette rather than importing Lok-Motion's colors directly — motion
  language shared, product identity stays per-app. Deliberately small.
  Natural next steps if this direction is wanted further: apply the same
  treatment to the boot/loading moment before the canvas initializes, or to
  panel-open transitions; pull in more effects from `lok-components.js`
  (glitch text, typewriter caret) for specific moments rather than
  everywhere. Respects `prefers-reduced-motion` (see the global rule in
  `index.html`) — keep that true of anything added here later.
- **Audio-reactive mode** — splat force or curl driven by mic/track input
- **Seed-as-collectible** — since a seed is already a shareable ~200-byte
  object, a lightweight "remix this seed" gallery is a small step from what
  exists, not a new system
- **Haptics on splat** — mobile-only nicety
- **Low-power auto-downscale** — detect thermal throttling, drop
  `simResolution`/`dyeResolution` automatically rather than making the user
  find the Tune sheet
- **Export watermark toggle** — depends on whether free vs. paid tiers become
  a thing; no product decision yet, don't build ahead of it
- **ffmpeg.wasm MP4 fallback** — only needed for browsers where native
  MediaRecorder can't produce MP4 (most non-Safari browsers land on WebM,
  which is broadly acceptable for the target platforms already). ~30MB
  download, so only worth it if a real user complaint shows up asking for MP4
  specifically outside Safari.

---

## Sequencing logic

The order above is deliberately not "easiest first." It's:

1. **v1.1** hardens what's built before anything new sits on top of it —
   shipping a deck on an untested video export would compound bugs.
2. **v1.2** is the earliest point the shared-substrate moat becomes visible
   to a user rather than just true in the code.
3. **v1.3** is depth on a system that's already proven, lower architectural
   risk than a new tool.
4. **v1.4** is explicitly de-prioritized relative to product moats — posting
   mechanics are commodity work and easy to add whenever, so they shouldn't
   compete for time against anything that makes the tool itself better.

If priorities shift, the one hard dependency in this order is that **v1.2
needs v1.1's `ToolDeck` wiring**, and **v1.5 (Lok-Motion integration) needs
v1.2** to have actually exercised `ToolDeck` with a second tool — everything
else can reorder freely.

---

## v1.0.1 — Import & Audio-Reactive Auto-Motion (added, shipped)

Two features, researched and built ahead of the v1.1/v1.2 sequence above
because they were explicitly requested. Notes here for why they were built
the way they were, and what's a real limitation vs. a v1.2+ improvement.

### Bring-your-own shape (SVG / PNG / JPG / WebP / GIF)

**Tech used:** the browser's native `Path2D()` constructor already parses SVG
path syntax directly — no parser dependency needed. `src/core/import.js` uses
`DOMParser` to pull `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`,
`<polyline>`, `<line>` out of an uploaded SVG, converts the primitive shapes
to path-data strings, and normalizes the combined bounding box to the same
0..1 space every other object lives in. It becomes a new `LokObject` kind
(`'svg'`) that flows through the existing pipeline — same transform, same
mode toggle, same mask rasterization.

Raster images (PNG/JPG/WebP/GIF) go a different route since there's no vector
to extract: `importRasterFile()` decodes the image via `createImageBitmap`,
thresholds it into a binary luminance mask (adjustable in the Import sheet),
and the result is stamped into both the collision mask and the display layer
as a bitmap rather than a path — that's the new `'stencil'` object kind.
Works well for logos and high-contrast silhouettes; a busy photo will need
threshold tuning to get a clean shape.

**Known limitation:** SVG and stencil objects are excluded from the seed-link
share state (`toJSON()` flags them `excluded: true`). A raw bitmap or an
arbitrary path array doesn't fit the ~200-byte motion-link moat — including
them would mean the "link" is actually a multi-kilobyte payload, which
defeats the point. They persist in-session and in exported files/video, just
not in the compact link. If this turns out to matter, the fix is a small
asset-hosting step (upload once, reference by ID) rather than cramming pixels
into a URL.

### Audio-reactive auto-motion (mp3 / direct link)

**Tech used:** Web Audio API's `AnalyserNode` off a `MediaElementAudioSourceNode`
— the standard, dependency-free way to get real-time frequency data in a
browser. `src/core/audio.js` splits the spectrum into bass/mid/treble bands
each frame, drives `curl` and `velocityDissipation` continuously from overall
loudness, and fires stronger splats on detected beats. Beat detection is
energy-based: compare instantaneous bass energy against a rolling local
average and fire when it spikes past a threshold — the same technique used by
`web-audio-beat-detector` and similar libraries, implemented directly rather
than adding a dependency since it's ~15 lines. A separate one-shot BPM
estimate runs via `OfflineAudioContext` + autocorrelation over a low-pass
energy envelope when a file is uploaded, shown as a rough tempo readout.

If a hidden reactive object exists (the reveal-through-motion trick from the
objects system), strong beats now flash it into view automatically — audio
driving the reveal primitive, not just the fluid.

**Scope decision — direct files/URLs only, not arbitrary links.** This is the
one place research changed the plan. A "paste any link" UI implies YouTube,
Spotify, SoundCloud page URLs — none of those are decodable client-side.
Web Audio can only analyze what it can get into an `AudioBuffer` or
`MediaElementSource`, and that requires either a local file or a CORS-enabled
*direct* audio file URL. Extracting audio from a YouTube page isn't a
front-end feature — it needs either a platform's official API (SoundCloud
has one; YouTube's ToS prohibits extraction) or a server-side download step,
which is a backend project with real legal surface, not something to bolt
onto a client-side tool. The Auto sheet says this explicitly rather than
accepting a link and failing silently later.

**Architectural note — this breaks the determinism moat, on purpose, for this
one mode.** Every other export in lokLiquid regenerates offline from a seed,
bit-for-bit reproducible. Audio-driven motion can't work that way — it
depends on live playback timing syncing to a real audio clock, which isn't
something `stepFrame()` can fast-forward through deterministically without a
full offline audio-rendering pipeline (`OfflineAudioContext` can decode and
analyze audio offline in principle — a real v1.2+ path if audio-driven seed
links turn out to matter — but wasn't in scope here). So audio-driven export
uses a new `recordLive()` capture path in `video.js` that captures the canvas
in real time via `captureStream(fps)`, separate from the deterministic
`record()` path used everywhere else. Plain seed exports are still exactly
reproducible; only the audio-driven ones aren't, and the UI says so.

### What this changes in the sequencing above

- **v1.1's device testing pass** now needs to cover file input, drag/drop,
  and `getUserMedia`-adjacent permissions (audio autoplay policies vary by
  browser and need a user gesture — the Play button satisfies that, but it's
  worth explicit testing on iOS Safari specifically).
- **A real v1.2+ candidate, not yet scheduled:** offline audio rendering via
  `OfflineAudioContext` so an audio-driven piece *could* become seed-reproducible
  after all — decode the track once, extract the full band/beat timeline as
  data, and feed that through the existing deterministic `stepFrame()` loop
  instead of live analysis. This would close the determinism gap above. Worth
  doing if audio-driven pieces turn out to be popular enough that people want
  to share them as seed links, not just export video.
