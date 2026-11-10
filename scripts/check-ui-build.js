// Web UI build checks: bundle budgets (plan section 7.1) and the contents of dist/ui.
//   node scripts/check-ui-build.js           budgets + dist/ui file rules
//   node scripts/check-ui-build.js --pack    also runs `npm pack --dry-run --json --ignore-scripts` and checks the package (7.2)
//   node scripts/check-ui-build.js --pack-json <file>   the same checks on saved `npm pack --dry-run --json` output
// Exit code 1 with a clear message when a rule is broken. Plain Node, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'ui');
const KB = 1024;

// Budgets in kB gzip (raw for distTotal), the values of plan 7.1. FINAL (step 18, the Svelte shell owns
// the page): the notices file must name every package of 7.1 (all five are bundled).
const FINAL = true;
export const BUDGETS = {
  initialJs: 116, // plan 7.1 (the legacy bundle was 51 kB)
  lazyViewer: 15,          // any single lazy viewer chunk
  lazyViewersTotal: 55,
  three: 220, // plan 7.1 (5.7b addons + ViewHelper)
  graphCards: 75,
  graphLayout: 30,
  palette: 14,
  picker: 5,
  dialogs: 45, // step 17: + Bits Tooltip/floating-ui via Button in the cleanup dialogs; not in plan 7.1 ("the dialogs' heavy parts are lazy"): a guard for the lazy DialogHost chunk (Bits Dialog)
  cssInitial: 14, // plan 7.1
  cssTotal: 20,
  distTotalRaw: 1.8 * 1024, // kB raw
  icons: 60,
};
// Strings that only a lazy library contains; none may appear in an initial chunk.
const LAZY_MARKERS = [
  ['svelte-flow__', '@xyflow/svelte'],
  ['network-simplex', '@dagrejs/dagre'],
  ['saturation-pointer', 'vanilla-colorful'], // the plan's marker "hex-alpha-color-picker" is also the element name our own code creates; this CSS part name exists only in the library
  ['fuzzysort', 'fuzzysort'],
  ['GTAOPass', 'three GTAOPass'],
  ['RoomEnvironment', 'three RoomEnvironment'],
];
const NOTICE_NAMES = FINAL ? ['svelte', 'bits-ui', 'three', 'lucide-static', 'virtua'] : ['three'];

const errors = [];
const fail = (m) => errors.push(m);
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / KB).toFixed(1);

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/** Relative static imports of a built JS chunk (not dynamic import()). */
export function staticImports(code) {
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*)["'](\.\.?\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 1), m.index);
    if (before === '(') continue;
    out.add(m[1]);
  }
  return [...out];
}

function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('dist/ui/index.html is missing: run npm run build:ui'); process.exit(1); }
  const files = walk(DIST);
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

  // ---- file rules ----
  for (const f of files) {
    if (f.endsWith('.map')) fail(`source map shipped: ${f}`);
    const ok = f === 'index.html' || f === 'build.json' || f === 'THIRD-PARTY-NOTICES.txt' || /^assets\/[^/]+\.(js|css)$/.test(f);
    if (!ok) fail(`unexpected file in dist/ui: ${f}`);
    if (/\.(js|css)$/.test(f) && fs.readFileSync(path.join(DIST, f), 'utf8').includes('sourceMappingURL')) fail(`sourceMappingURL in ${f}`);
  }
  if (!/<head>/.test(html)) fail('dist/ui/index.html must contain a literal <head> (the server injects the UI token there)');
  if (/(?:src|href)=["'](?:https?:)?\/\//i.test(html)) fail('index.html references an absolute URL / another origin');
  // step 21: the build stamp the server compares with the package version and the web/ sources
  if (!files.includes('build.json')) fail('build.json is missing (the agent-art-build-stamp plugin in vite.config.js writes it)');
  else {
    const stamp = JSON.parse(fs.readFileSync(path.join(DIST, 'build.json'), 'utf8'));
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    if (stamp.version !== version || !Number.isFinite(stamp.builtAt)) fail(`build.json ${JSON.stringify(stamp)} does not match { version: "${version}", builtAt: <ms> }`);
  }
  if (!files.includes('THIRD-PARTY-NOTICES.txt')) fail('THIRD-PARTY-NOTICES.txt is missing');
  else {
    const n = fs.readFileSync(path.join(DIST, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const name of NOTICE_NAMES) {
      const bundled = files.some((f) => f.endsWith('.js'));
      if (bundled && !new RegExp(`^${name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')} `, 'm').test(n)) fail(`THIRD-PARTY-NOTICES.txt does not name ${name}`);
    }
  }

  // ---- initial set ----
  const initial = new Set();
  const queue = [];
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) queue.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) queue.push(m[1]);
  const cssInitial = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => path.posix.normalize(m[1].replace(/^\.\//, '')));
  while (queue.length) {
    const rel = path.posix.normalize(queue.shift().replace(/^\.\//, ''));
    if (initial.has(rel) || !files.includes(rel)) continue;
    initial.add(rel);
    const code = fs.readFileSync(path.join(DIST, rel), 'utf8');
    for (const imp of staticImports(code)) queue.push(path.posix.join(path.posix.dirname(rel), imp));
  }

  const sizeOf = (f) => { const b = fs.readFileSync(path.join(DIST, f)); return { raw: b.length, gz: gz(b) }; };
  const rows = [];
  let initialGz = 0, cssInit = 0, cssTotal = 0, lazyTotal = 0, distRaw = 0, graphCardsGz = 0;
  const js = files.filter((f) => f.endsWith('.js'));
  const css = files.filter((f) => f.endsWith('.css'));
  for (const f of files) distRaw += sizeOf(f).raw;
  for (const f of js) {
    const s = sizeOf(f);
    const base = path.posix.basename(f);
    const isInitial = initial.has(f);
    const code = fs.readFileSync(path.join(DIST, f), 'utf8');
    let kind = isInitial ? 'initial' : 'lazy';
    if (/^three-/.test(base)) kind = 'three';
    // the Cards renderer: the vendor chunk (Svelte Flow + d3) plus our graph/flow/* chunks, one budget together
    else if (/^graph-cards-/.test(base) || (!isInitial && /^(FlowGraph|mountFlow)-/.test(base))) kind = 'graph-cards';
    else if (/^graph-layout-/.test(base)) kind = 'graph-layout';
    else if (!isInitial && /^CommandPalette-|^palette-/.test(base)) kind = 'palette';
    else if (!isInitial && code.includes('saturation-pointer')) kind = 'picker';
    // DialogHost, and (step 18b) the shared ui/Dialog + Bits Dialog chunk that DialogHost and the palette both import
    else if (!isInitial && /^(DialogHost|Dialog)-/.test(base)) kind = 'dialogs';
    rows.push([f, kind, s.raw, s.gz]);
    if (isInitial) initialGz += s.gz;
    if (kind === 'three' && isInitial) fail(`the three chunk ${f} is in the initial set`);
    if (kind === 'three' && s.gz > BUDGETS.three * KB) fail(`three chunk ${kb(s.gz)} kB > ${BUDGETS.three} kB`);
    if (kind === 'graph-cards') graphCardsGz += s.gz;
    if (kind === 'graph-cards' && isInitial) fail(`the graph-cards chunk ${f} is in the initial set`);
    if (kind === 'graph-layout' && isInitial) fail(`the graph-layout chunk ${f} is in the initial set`);
    if (kind === 'graph-layout' && s.gz > BUDGETS.graphLayout * KB) fail(`graph-layout chunk ${kb(s.gz)} kB > ${BUDGETS.graphLayout} kB`);
    if (kind === 'palette' && s.gz > BUDGETS.palette * KB) fail(`palette chunk ${kb(s.gz)} kB > ${BUDGETS.palette} kB`);
    if (kind === 'dialogs' && s.gz > BUDGETS.dialogs * KB) fail(`dialogs chunk ${kb(s.gz)} kB > ${BUDGETS.dialogs} kB`);
    if (kind === 'picker' && s.gz > BUDGETS.picker * KB) fail(`colour picker chunk ${kb(s.gz)} kB > ${BUDGETS.picker} kB`);
    if (kind === 'lazy') {
      lazyTotal += s.gz;
      if (s.gz > BUDGETS.lazyViewer * KB) fail(`lazy chunk ${f} ${kb(s.gz)} kB > ${BUDGETS.lazyViewer} kB`);
    }
    // marker: three's core logs with this prefix; viewer code that merely calls new WebGLRenderer() does not
    if (kind !== 'three' && code.includes('THREE.WebGLRenderer: ')) fail(`three.js code outside the three chunk: ${f}`);
    if (kind !== 'three' && /GTAOPass|RoomEnvironment/.test(code)) fail(`GTAOPass / RoomEnvironment outside the three chunk: ${f}`);
    if (isInitial) for (const [marker, lib] of LAZY_MARKERS) if (code.includes(marker)) fail(`${lib} leaked into the initial chunk ${f} (marker "${marker}")`);
  }
  for (const f of css) {
    const s = sizeOf(f);
    rows.push([f, cssInitial.includes(f) ? 'css initial' : 'css lazy', s.raw, s.gz]);
    cssTotal += s.gz;
    if (cssInitial.includes(f)) cssInit += s.gz;
  }
  if (graphCardsGz > BUDGETS.graphCards * KB) fail(`graph-cards chunks ${kb(graphCardsGz)} kB > ${BUDGETS.graphCards} kB (stop and report: do not raise this budget)`);
  if (initialGz > BUDGETS.initialJs * KB) fail(`initial JS ${kb(initialGz)} kB > ${BUDGETS.initialJs} kB`);
  if (lazyTotal > BUDGETS.lazyViewersTotal * KB) fail(`lazy viewer chunks together ${kb(lazyTotal)} kB > ${BUDGETS.lazyViewersTotal} kB`);
  if (cssInit > BUDGETS.cssInitial * KB) fail(`initial CSS ${kb(cssInit)} kB > ${BUDGETS.cssInitial} kB`);
  if (cssTotal > BUDGETS.cssTotal * KB) fail(`total CSS ${kb(cssTotal)} kB > ${BUDGETS.cssTotal} kB`);
  if (distRaw > BUDGETS.distTotalRaw * KB) fail(`dist/ui ${kb(distRaw)} kB raw > ${BUDGETS.distTotalRaw} kB`);
  const icons = fs.existsSync(path.join(ROOT, 'web/src/lib/util/icons.ts')) ? (fs.readFileSync(path.join(ROOT, 'web/src/lib/util/icons.ts'), 'utf8').match(/lucide-static\/icons\//g) || []).length : 0;
  if (icons > BUDGETS.icons) fail(`${icons} Lucide icons imported > ${BUDGETS.icons}`);

  rows.sort((a, b) => a[1].localeCompare(b[1]) || b[3] - a[3]);
  console.log('file'.padEnd(52), 'kind'.padEnd(13), 'raw kB'.padStart(8), 'gzip kB'.padStart(8));
  for (const [f, k, raw, g] of rows) console.log(f.padEnd(52), k.padEnd(13), kb(raw).padStart(8), kb(g).padStart(8));
  console.log(`initial JS ${kb(initialGz)} / ${BUDGETS.initialJs} kB · lazy viewers ${kb(lazyTotal)} / ${BUDGETS.lazyViewersTotal} kB · graph-cards ${kb(graphCardsGz)} / ${BUDGETS.graphCards} kB · CSS initial ${kb(cssInit)} / ${BUDGETS.cssInitial} kB · CSS total ${kb(cssTotal)} / ${BUDGETS.cssTotal} kB · dist ${kb(distRaw)} / ${BUDGETS.distTotalRaw} kB raw · icons ${icons} / ${BUDGETS.icons}`);

  if (process.argv.includes('--pack') || process.argv.includes('--pack-json')) checkPack();

  if (errors.length) {
    console.error('\nUI build check FAILED:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  console.log('UI build check ok');
}

/**
 * Plan 7.2: problems with a package file list (`npm pack --dry-run --json` -> [0].files[].path) and
 * package.json. Pure, so test/ui.test.js can feed it lists.
 */
export function packProblems(list, pkg) {
  const out = [];
  list = list.map((f) => f.replace(/\\/g, '/'));
  for (const need of ['dist/ui/index.html', 'dist/ui/build.json', 'dist/ui/THIRD-PARTY-NOTICES.txt']) if (!list.includes(need)) out.push(`package lacks ${need}`);
  for (const re of [/^dist\/ui\/assets\/index-.*\.js$/, /^dist\/ui\/assets\/index-.*\.css$/, /^dist\/ui\/assets\/three-.*\.js$/]) if (!list.some((f) => re.test(f))) out.push(`package lacks a file matching ${re}`);
  for (const f of list) {
    if (/^(web|e2e|test|docs|scripts|node_modules|test-results)\//.test(f)) out.push(`package contains ${f}`);
    else if (/^(playwright\.config\.ts|vite\.config\.js|svelte\.config\.js|tsconfig\.json)$/.test(f) || f.endsWith('.map') || f === 'src/meshfixtures.js') out.push(`package contains ${f}`);
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) out.push('package.json dependencies must be empty');
  if (pkg.scripts?.postinstall || pkg.scripts?.prepare) out.push('no postinstall / prepare script allowed');
  if (!pkg.files?.includes('dist/ui/')) out.push('files must list dist/ui/');
  if (pkg.scripts?.prepack !== 'npm run build:ui') out.push('prepack must be npm run build:ui');
  return out;
}

/**
 * The file list from `npm pack --dry-run --json` output. npm may print lines before the JSON (a prepack
 * build); npm <= 10 prints an array of packages, npm 11 an object keyed by package name.
 */
export function packFileList(output) {
  const start = output.search(/^[[{]/m);
  if (start < 0) throw new Error('npm pack printed no JSON');
  const j = JSON.parse(output.slice(start));
  const entry = Array.isArray(j) ? j[0] : Object.values(j)[0];
  if (!Array.isArray(entry?.files)) throw new Error('npm pack JSON has no file list');
  return entry.files.map((f) => f.path.replace(/\\/g, '/'));
}

/**
 * Plan 7.2: what `npm pack` would publish. `--pack-json <file>` reads saved `npm pack --dry-run --json`
 * output; otherwise it runs `npm pack --dry-run --json --ignore-scripts` (no prepack rebuild here: this
 * script checks the dist/ui that is already built, run npm run build:ui first).
 */
function checkPack() {
  const at = process.argv.indexOf('--pack-json');
  const out = at > 0 && process.argv[at + 1]
    ? fs.readFileSync(path.resolve(process.argv[at + 1]), 'utf8')
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
  const list = packFileList(out);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const m of packProblems(list, pkg)) fail(m);
  console.log(`pack: ${list.length} files, ${list.filter((f) => f.startsWith('dist/ui/')).length} under dist/ui`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
