# LAUNCH.md

Getting this from a zip to a live MVP.

---

## 1. Transfer to git

The repo `mistachatty-cmyk/lokLiquid` exists but is private. If you can't
open it in a browser, confirm you're signed into the account that owns it —
GitHub renders a private repo you're not authenticated for as a 404, which
looks exactly like it doesn't exist.

```bash
unzip lokliquid-repo.zip
cd lokliquid

git init
git add -A
git commit -m "feat: lokLiquid v1 — solver, objects, studio, ad pipeline"

git remote add origin https://github.com/mistachatty-cmyk/lokLiquid.git
git branch -M main
git push -u origin main
```

If the push is rejected because the remote already has a commit:

```bash
git pull --rebase origin main
git push -u origin main
```

### Or let Claude Code do it

From the unzipped folder:

```bash
claude
```

Then: *"Read CLAUDE.md, then initialize git and push this to
github.com/mistachatty-cmyk/lokLiquid on main."*

Claude Code will pick up `CLAUDE.md` automatically as project context on every
session in this directory.

---

## 2. Deploy

No build step. Plain ES modules, static root.

**Vercel:**
```bash
npx vercel
```
- Framework preset: **Other**
- Build command: *(leave empty)*
- Output directory: `.`

**Or via dashboard:** import the GitHub repo, same settings. Pushes to `main`
auto-deploy from then on.

**Netlify / Cloudflare Pages:** same — no build command, publish directory `.`.

### One gotcha
Serve over **HTTPS**. `navigator.share()`, clipboard write, and
`getUserMedia`-adjacent APIs are all secure-context only. Vercel gives you
HTTPS by default; a bare IP or `http://` host will silently break sharing.

---

## 3. Pre-launch checklist

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

## 4. What to actually launch as MVP

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

## 5. First week after launch

In priority order, from the roadmap:

1. Fix whatever real-device testing surfaced (this will not be nothing)
2. Wire `ToolDeck` — it's built and unused
3. Move the brand strip to `public/brands.json` so it updates without a deploy
4. Fix plotter export to trace actual mask geometry
5. Start the `lok-fluid` npm extraction (see SPINOFFS.md — widest reach, most
   reuse, and every improvement flows back here)

---

## 6. Files in this repo

| File | For |
|---|---|
| `CLAUDE.md` | Claude Code project context — read first |
| `README.md` | Architecture, moats, API |
| `ROADMAP.md` | Version plan and sequencing logic |
| `SPINOFFS.md` | Extractable products and their roadmaps |
| `COMMITS.md` | Suggested commit sequence |
| `LAUNCH.md` | This file |
