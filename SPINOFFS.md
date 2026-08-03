# lokLiquid — Extractable Tools

What's already built that can become its own shippable thing, ranked by
**speed to a quality release**, not by ambition. Each entry says what exists,
what's actually missing, and where it goes over time.

The filter throughout: a spin-off should be *mostly done already*. If it needs
a new engine, it's not a spin-off — it's a new product wearing a spin-off's
clothes.

---

## Tier 1 — Ship in days

### 1. `lok-fluid` — embeddable background component
**Status: ~90% done.** `src/core/lok-fluid.js` is already standalone, has zero
dependencies, and has a clean API (`splat`, `stroke`, `set`, `seek`,
`stepFrame`, `getShareState`, `destroy`). It's the single most reusable thing
in the repo.

**The product:** a drop-in animated background for landing pages and hero
sections. One script tag, one line of config. The pitch is that it's
deterministic — the same seed renders identically for every visitor, so a
designer can pick a look and know what ships.

**What's missing:**
- npm package scaffolding + ESM/UMD dual build
- An `autoplay` mode that runs ambient motion with no interaction wired up
- `IntersectionObserver` auto-pause when scrolled off-screen (battery)
- A tiny docs page — which is really just the demo you already have

**Roadmap:**
- *v0.1* — npm publish, script-tag build, five presets, autopause
- *v0.2* — React/Vue wrapper components, `prefers-reduced-motion` honoured by default
- *v0.3* — theme-from-CSS-variables so it inherits a site's palette automatically
- *v1.0* — the obstacle/mask system exposed, so a site's logo becomes an obstacle in its own hero

**Why it's first:** it's the widest possible distribution of the core asset,
and every improvement to it improves lokLiquid too. Shared code, not a fork.

---

### 2. Silhouette Maker — image → reactive stencil
**Status: ~80% done.** `src/core/import.js` already decodes any raster,
thresholds it to a binary mask, and produces a usable stencil.

**The product:** drop in a photo or logo, get back a clean silhouette as PNG
with alpha, or as an SVG outline. Useful well beyond fluid — stickers, cutouts,
merch prep, plotter work.

**What's missing:**
- Contour tracing to a real vector path (currently the stencil stays raster;
  the marching-squares step is scoped but not written)
- Edge smoothing + despeckle pass
- Export UI (PNG-with-alpha and SVG)

**Roadmap:**
- *v0.1* — upload, threshold slider, PNG-with-alpha export
- *v0.2* — contour trace to SVG, simplify tolerance control
- *v0.3* — multi-level posterize (2–5 tone separations, which is exactly what riso printing wants)
- *v0.4* — batch mode for a folder of images

---

### 3. Track Analyzer — audio → beat grid JSON
**Status: ~85% done.** `analyzeTrack()` in `src/core/ad-renderer.js` already
does offline decode, three-band energy extraction, percentile normalization,
beat flagging, and BPM estimation. It returns clean data.

**The product:** upload a track, get a JSON beat map — BPM, beat timestamps,
per-frame band energies. For motion designers scripting to music, or as a
free utility that feeds people into the main tool.

**What's missing:**
- A JSON/CSV download button (the data structure is already right)
- A waveform + beat marker visualization
- Downbeat/bar detection (currently beats only, not "which beat is the 1")

**Roadmap:**
- *v0.1* — upload, BPM readout, JSON export
- *v0.2* — waveform view with beat markers, manual tap-to-correct BPM
- *v0.3* — bar/downbeat detection, time signature guess
- *v0.4* — After Effects keyframe export (`.jsx`), which is the format that makes motion designers actually adopt it

---

## Tier 2 — Ship in a couple of weeks

### 4. Flow Plotter — generative SVG for pen plotters
**Status: ~70% done.** `src/core/plotter.js` traces streamlines, simplifies
with Douglas-Peucker, and emits millimetre SVG with per-pen groups. That's the
hard part.

**The product:** a generative art tool for the AxiDraw / plotter / riso
community — a small, vocal, underserved audience that pays for good tools.

**What's missing:**
- Paper size presets (A3/A4/Letter, portrait/landscape) — currently A4 hardcoded
- Multi-pen colour assignment UI (the `pens` array exists, no UI drives it)
- Travel-path optimization (reorder lines to minimize pen-up movement — a real
  quality issue on long plots)
- Preview showing plot time estimate

**Roadmap:**
- *v0.1* — paper presets, density/simplify controls, single-pen SVG
- *v0.2* — multi-pen separation UI, travel optimization
- *v0.3* — seed gallery, since determinism means a plot is reproducible from a
  200-byte link — genuinely novel for this community
- *v0.4* — HPGL export for older plotters, G-code for pen-mounted CNC

**Note:** this one has the strongest moat (moat #3) and the smallest audience.
Good for credibility and word-of-mouth, not for volume.

---

### 5. Beat-Synced Ad Maker — the client tool, standalone
**Status: ~75% done.** `brand.js` + `ad.js` + `ad-renderer.js` are the whole
pipeline: logo → palette, track → beat grid, template → timed cues, render →
video.

**The product:** the Ad Studio flow as its own focused product, without the
drawing tools. Upload logo, upload track, pick template, get a spot.

**What's missing:**
- More templates (five now; this category lives or dies on template quality)
- Template preview thumbnails rather than text labels
- Reliable audio muxing — the current live-capture path works but is the
  weakest link (see the known-issues note in the launch doc)
- Multi-format batch export (render 9:16 + 1:1 + 16:9 in one pass, since the
  overlay compositor already re-renders per aspect without re-simulating)

**Roadmap:**
- *v0.1* — current flow, cleaned up, 8–10 templates
- *v0.2* — batch multi-format export, template thumbnails
- *v0.3* — brand kit sharing via link so a client can self-serve
- *v0.4* — server-side render for reliable audio muxing (the honest fix)

---

## Tier 3 — Real projects, not extractions

### 6. `lok-help` — the cross-platform help layer
`src/core/help.js` is genuinely generic — hover, long-press, and help-mode in
~200 lines with no dependencies. Could be a small open-source package.

**Why it's worth doing anyway:** open-sourcing a small, well-made utility is
cheap credibility, and it costs almost nothing since the code exists. Not a
revenue path. Do it when there's a spare afternoon, not on a schedule.

### 7. Seed-link pattern — determinism as a library
The `{seed, config} → 200 bytes → identical render` pattern (`capture.js`)
generalizes to any generative tool. This is a *technique*, not a product, and
probably belongs in a blog post rather than a package.

---

## What NOT to extract

- **The object/collision system** — it only makes sense inside a fluid sim.
  Extracting it produces a worse version of a physics engine.
- **The tool deck** — it's shell infrastructure. It has no value without tools
  to put in it.
- **Anything requiring a backend** — YouTube posting, server-side render,
  hosted brand kits. These are real projects with real ops cost. They aren't
  spin-offs and shouldn't be scoped as if they were.

---

## Suggested order

1. **`lok-fluid` npm package** — widest reach, most reuse, improves the parent
2. **Track Analyzer** — smallest gap between "exists" and "shippable"
3. **Silhouette Maker** — genuinely useful outside this niche
4. **Flow Plotter** — strongest differentiation, smallest audience
5. **Ad Maker standalone** — highest revenue potential, but wait until the
   audio muxing is solid, because a client-facing tool that ships silent video
   is worse than no tool

The first three share code with the main app rather than forking it. Keep
them in one repo as separate entry points until there's a concrete reason to
split — a premature monorepo split is a lot of maintenance for no user benefit.
