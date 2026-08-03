#!/usr/bin/env node
/**
 * lokLiquid bundler — inlines every module into index.html to produce a
 * single-file build that opens without a server.
 *
 * No build tool on purpose. If the module list grows much past ~15, swap this
 * for esbuild; the dependency-free tradeoff has a limit.
 *
 *   node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

// DEPENDENCY ORDER MATTERS — a module must come after anything it
// references at module scope.
const FILES = [
  'src/core/lok-fluid.js',
  'src/core/objects.js',
  'src/core/capture.js',
  'src/core/video.js',
  'src/core/plotter.js',
  'src/core/import.js',
  'src/core/audio.js',
  'src/core/brand.js',
  'src/core/ad.js',
  'src/core/ad-renderer.js',
  'src/core/help.js',
  'src/shell/tool-contract.js',
  'src/app.js'
];

const strip = (src) => src
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*[^;]+;\s*$/gm, '')
  .replace(/^import [^;]*?;\s*$/gm, '')
  .replace(/^export default class/gm, 'class')
  .replace(/^export (const|function|class|let|var)/gm, '$1');

const bundle = FILES
  .map(f => `/* ===== ${f} ===== */\n` + strip(readFileSync(f, 'utf8')))
  .join('\n\n');

// guard: duplicate top-level names across modules would silently shadow
const names = {};
for (const m of bundle.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
  names[m[1]] = (names[m[1]] || 0) + 1;
}
const dupes = Object.entries(names).filter(([, n]) => n > 1);
if (dupes.length) {
  console.error('Duplicate top-level declarations:', dupes.map(([k]) => k).join(', '));
  process.exit(1);
}

const html = readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="./src/app.js"></script>',
           '<script type="module">\n' + bundle + '\n</script>');

writeFileSync('lokliquid.html', html);
console.log(`Built lokliquid.html — ${(html.length / 1024).toFixed(0)}KB, ${FILES.length} modules`);
