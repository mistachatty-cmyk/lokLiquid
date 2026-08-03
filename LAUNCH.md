# LAUNCH.md

Taking this MVP live.

The repo `mistachatty-cmyk/lokLiquid` is on GitHub and private. If you can't
open it in a browser, confirm you're signed into the account that owns it —
GitHub renders a private repo you're not authenticated for as a 404, which
looks exactly like it doesn't exist.

---

## 1. Deploy

No build step. Plain ES modules, static root.

**Vercel:** `vercel.json` at repo root pins framework to none, build command to
none, and output directory to `.`, so it deploys correctly with zero manual
dashboard configuration — no need to override Vercel's auto-detection.
```bash
npx vercel        # preview
npx vercel --prod # production
```
Or import the GitHub repo via the dashboard — same config is picked up
automatically from `vercel.json`. Pushes to `main` auto-deploy from then on.

`vercel.json` also sets a few baseline response headers (`X-Content-Type-Options`,
`Referrer-Policy`, and a `Permissions-Policy` disabling camera/mic/geolocation,
none of which lokLiquid uses). No CSP is set — the app relies on inline
`<style>`/`<script type="module">` in `index.html`, and a strict CSP would need
those specifically allowed; add one deliberately if that becomes a requirement,
don't bolt on a default.

**Netlify / Cloudflare Pages:** same — no build command, publish directory `.`.
(`vercel.json` is Vercel-specific; these platforms would need their own
equivalent config file if the same zero-touch setup is wanted there.)

### One gotcha
Serve over **HTTPS**. `navigator.share()`, clipboard write, and
`getUserMedia`-adjacent APIs are all secure-context only. Vercel gives you
HTTPS by default; a bare IP or `http://` host will silently break sharing.

---

## 2. Pre-launch checklist

Ordered by how badly it hurts to skip.

### Must do before showing anyone
- [ ] **Test on a real iPhone in Safari.** Not the in-app browser. This is the
      single biggest gap — the whole thing is syntax-verified but hasn't run on
      physical hardware.
- [ ] **Test on a real Android in Chrome.** Float texture support varies more
      on Android than iOS; the probe screen will tell you if it fails.
- [ ] Draw for 60 seconds, rotate the phone several times, background the app
      and return. Watch for: black canvas (context loss), sluggishness (GPU
      leak), stuck strokes (`pointercancel`).
- [ ] Place a symbol, confirm the fluid **visibly** splits around it. If it
      doesn't, the mask is stroking instead of filling.
- [ ] Export a PNG, a video, and a plotter SVG. Open all three.
- [ ] Copy a motion link, open it in a fresh tab, confirm identical motion.

### Should do before a public launch
- [ ] Run the Ad Studio flow end to end with a real client logo and track
- [ ] Confirm the "with audio" export actually has audio (known weak point —
      see CLAUDE.md known issues)
- [ ] Check the help system: hover on desktop, long-press on mobile, `?` mode
- [ ] Test with `prefers-reduced-motion` enabled
- [ ] Try a deliberately huge SVG and a 10MB photo — confirm the size guards fire

### Nice to have
- [ ] Add a favicon and OG image (currently neither — links will preview blank)
- [ ] Set `<meta name="description">` for search/social
- [ ] Analytics, if you want any

---

## 3. What to actually launch as MVP

**Recommendation: launch the single-tool creative app, hold Ad Studio back.**

The drawing → capture → export → share loop is complete, self-explanatory, and
the parts most likely to break are the ones you can test in ten minutes. Ad
Studio is the higher-value product but has the known audio-muxing weakness,
and a client-facing tool that hands someone a silent "finished ad" damages
trust more than a delayed launch does.

Suggested sequencing:
1. **Soft launch** the creative tool. Get it on real devices, fix what breaks.
2. **Then** open Ad Studio, once audio muxing is verified on the devices your
   clients actually use.

If you want Ad Studio in the MVP anyway, at minimum relabel the silent export
so nobody mistakes it for the deliverable — the current copy says so, but a
client won't read it.

---

## 4. First week after launch

In priority order, from the roadmap:

1. Fix whatever real-device testing surfaced (this will not be nothing)
2. Wire `ToolDeck` — it's built and unused
3. Move the brand strip to `public/brands.json` so it updates without a deploy
4. Fix plotter export to trace actual mask geometry
5. Start the `lok-fluid` npm extraction (see SPINOFFS.md — widest reach, most
   reuse, and every improvement flows back here)

---

## 5. Files in this repo

| File | For |
|---|---|
| `CLAUDE.md` | AI coding agent context (conventions, invariants, module map) — read first |
| `README.md` | Architecture, moats, API |
| `ROADMAP.md` | Version plan and sequencing logic |
| `SPINOFFS.md` | Extractable products and their roadmaps |
| `COMMITS.md` | Suggested commit sequence |
| `LAUNCH.md` | This file |

---

## 6. Lok-Motion integration (future)

lokLiquid is planned as a tool option inside the broader
[Lok-Motion](https://github.com/mistachatty-cmyk/Lok-Motion) product, not just
a standalone app. Nothing below is scheduled yet — noting it here so it isn't
lost:

- No integration work has started; this repo still ships and runs standalone.
- When it's time, the natural seam is `src/shell/tool-contract.js`'s
  `LokTool`/`ToolDeck` contract — it was designed so lokLiquid can mount as one
  tool among several in a host shell rather than owning the whole page.
- Decide then: does Lok-Motion vendor this repo as a git submodule/npm
  package, or fork the `LokTool`-wrapped core in? The `lok-fluid` npm
  extraction (SPINOFFS.md) is the same underlying work either way, so doing
  that first de-risks whichever path is chosen.
