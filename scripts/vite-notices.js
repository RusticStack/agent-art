// Vite build plugin: writes dist/ui/THIRD-PARTY-NOTICES.txt (name, version, licence id and full
// licence text of every package that ends up in the bundle) and fails the build when a bundled
// package has a licence outside the allow-list, or is on the forbidden list.
// MIT, ISC and BSD all require the copyright notice to travel with copies; the minified bundle only
// keeps /*! */ banners, which most packages do not have.
import fs from 'node:fs';

export const ALLOWED = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD'];
export const FORBIDDEN = ['@internationalized/date'];

/** Package root ("…/node_modules/@scope/name" or "…/node_modules/name") of a module id, or null. */
export function packageRootOf(id) {
  const clean = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0];
  const i = clean.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = clean.slice(i + '/node_modules/'.length).split('/');
  const n = rest[0].startsWith('@') ? 2 : 1;
  if (rest.length < n) return null;
  return clean.slice(0, i + '/node_modules/'.length) + rest.slice(0, n).join('/');
}

/** Normalise an SPDX-ish licence field ("MIT", {type:"MIT"}, "(MIT OR Apache-2.0)") to a list of ids. */
export function licenceIds(lic) {
  const s = typeof lic === 'string' ? lic : lic?.type || '';
  return s.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+|\s+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Pure core: from bundled module ids, collect one notice per package.
 * readFile(path) returns the file text or null when it does not exist; listDir(path) returns names.
 */
export function noticesFor(moduleIds, readFile, listDir = () => []) {
  const roots = new Set();
  for (const id of moduleIds) { const r = packageRootOf(id); if (r) roots.add(r); }
  const out = new Map();
  for (const root of roots) {
    const pj = readFile(root + '/package.json');
    if (pj === null) continue;
    const pkg = JSON.parse(pj);
    const name = pkg.name || root.split('/node_modules/').pop();
    if (FORBIDDEN.includes(name)) throw new Error(`[notices] ${name} must not be bundled`);
    const ids = licenceIds(pkg.license ?? pkg.licenses?.[0]);
    if (!ids.length || !ids.some((x) => ALLOWED.includes(x))) throw new Error(`[notices] ${name}@${pkg.version}: licence "${ids.join(' ') || 'none'}" is not in the allow-list (${ALLOWED.join(', ')})`);
    const file = listDir(root).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = (file && readFile(root + '/' + file)) || `${ids.join(' OR ')} licence (no licence file shipped in the package).`;
    const key = `${name}@${pkg.version}`;
    if (!out.has(key)) out.set(key, { name, version: pkg.version, licence: ids.join(' OR '), text: text.trim() });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

export function formatNotices(list) {
  const head = 'Agent Art web UI: third-party software bundled in this build.\n\n';
  return head + list.map((n) => `${'='.repeat(78)}\n${n.name} ${n.version}\nLicence: ${n.licence}\n${'-'.repeat(78)}\n${n.text}\n`).join('\n');
}

export function notices() {
  return {
    name: 'agent-art-third-party-notices',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const ids = [];
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') ids.push(...Object.keys(chunk.modules || {}), ...(chunk.moduleIds || []));
      const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
      const list = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
      const all = noticesFor(ids, read, list);
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: formatNotices(all) });
    },
  };
}

