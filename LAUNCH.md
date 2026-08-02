# Suggested commit sequence

```bash
git checkout -b feat/lokliquid-v1

# 1 — stability first, alone, so phone testing is comfortable
git add index.html
git commit -m "fix(canvas): lock touch-action and overscroll to stop page drift while drawing"

# 2 — solver
git add src/core/lok-fluid.js
git commit -m "feat(core): clean-room stable-fluids solver with obstacle mask, GL disposal, context-loss recovery"

# 3 — object system
git add src/core/objects.js
git commit -m "feat(objects): unified LokObject model — symbols, pen, text; dirty-flagged mask rasterizer"

# 4 — capture + share
git add src/core/capture.js
git commit -m "feat(studio): offline deterministic frame export, share presets, seed links"

# 5 — shell
git add src/app.js
git commit -m "feat(app): gestures, layers panel, studio sheet, brand strip"

# 6 — docs
git add README.md COMMITS.md package.json .gitignore
git commit -m "docs: architecture, moats, determinism contract, bug guards"

git push -u origin feat/lokliquid-v1
```

Deploy: Vercel picks up a static root automatically — no build step, it's
plain ES modules. Set output directory to repo root.
