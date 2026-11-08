// art_cleanup: selectors, dependency blocking and cascade, approved / pinned protection, the export
// path allowlist (outside, traversal, symlinks), trash + restore round trip (byte identical), manifest
// pruning, empty as the only hard delete, compact output bounds, single deletes through the trash,
// replace (superseding) and the asset type registration hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { runTool, touchedAssets } from '../src/mcp.js';
import { registerAssetType } from '../src/assettypes.js';
import { globRe, parseAge } from '../src/cleanup.js';
import { assetIndex } from '../src/assets.js';

const tmp = (p = 'agent-art-cleanup-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ids = (r) => (r.items || []).map((x) => (typeof x === 'string' ? x.split(' ')[0] : x.id));
const plan = (e, a) => e.run('cleanup_plan', { full: true, ...a });
const planIds = (e, a) => plan(e, a).items.map((x) => x.id).sort();

/** A small workspace: a project with palette, canvases, a model with a texture, a rig, audio, exports. */
function workspace() {
  const home = tmp();
  const e = new Engine({ home });
  e.run('project_create', { name: 'marines', palette: { a: '#123456' } });
  for (const n of ['marine_a', 'marine_b', 'marine_c']) e.run('create', { name: n, width: 8, project: 'marines' });
  e.run('create', { name: 'crate_tex', width: 8 });
  e.run('create', { name: 'loose', width: 8 });
  e.run('model_create', { name: 'crate', parts: [{ type: 'box', size: [32, 32, 32], texture: 'crate_tex' }] });
  e.run('model_create', { name: 'rifle_v1', parts: [{ type: 'box', size: [32, 8, 8], color: '#555555' }] });
  e.run('create', { name: 'rifle_side', width: 8, meta: { renders: { side: { model: 'rifle_v1' } } } });
  e.run('rig_create', { name: 'bob', template: 'blob', frame: [16, 16] });
  e.run('rig_animate', { name: 'bob', preset: 'idle' });
  e.run('audio_sfx', { name: 'blip', recipe: 'click', seed: 1 });
  e.run('export', { canvas: 'marine_a' });
  e.run('export', { canvas: 'loose', path: 'weapons/rifle/loose.png' });
  e.flush();
  return { e, home };
}

test('cleanup: globs and ages parse', () => {
  assert.ok(globRe('marine_*').test('marine_a'));
  assert.ok(!globRe('weapons/*').test('weapons/rifle/x.png'));
  assert.ok(globRe('weapons/**').test('weapons/rifle/x.png'));
  assert.ok(globRe('weapons/rifle/*').test('weapons/rifle/x.png'));
  assert.ok(Math.abs(parseAge('2d', 1e10) - (1e10 - 2 * 86400000)) < 1);
  assert.ok(Math.abs(parseAge(1, 1e10) - (1e10 - 86400000)) < 1);
  assert.throws(() => parseAge('soon'), /age "soon"/);
});

test('cleanup: every selector type', () => {
  const { e } = workspace();
  e.run('graph_tag', { node: 'marine_b', add: ['old'] });
  e.run('graph_group', { name: 'Armour' });
  e.run('graph_group', { name: 'Helmets', members: ['marine_c'], parent: 'Armour' });
  e.run('graph_link', { from: 'marine_b', rel: 'variant_of', to: 'marine_a' });
  e.run('graph_link', { from: 'marine_c', rel: 'replaces', to: 'loose' });
  // names (globs), ids, exclude, kind
  assert.deepEqual(planIds(e, { select: { names: ['marine_*'] } }), ['canvas:marine_a', 'canvas:marine_b', 'canvas:marine_c']);
  assert.deepEqual(planIds(e, { select: { names: ['marine_*'], exclude: ['*_c'] } }), ['canvas:marine_a', 'canvas:marine_b']);
  assert.deepEqual(planIds(e, { select: { ids: ['loose', 'model:crate'] } }), ['canvas:loose', 'model:crate']);
  assert.deepEqual(planIds(e, { select: { kind: 'model' } }), ['model:crate', 'model:rifle_v1']);
  assert.deepEqual(planIds(e, { select: { kind: 'audio' } }), ['audio:blip']);
  assert.deepEqual(planIds(e, { select: { kind: 'rig' } }), ['rig:bob']);
  // export paths match globs (exports only when asked for)
  assert.deepEqual(planIds(e, { select: { kind: 'export', names: ['weapons/rifle/*'] } }), ['export:weapons/rifle/loose.png']);
  assert.ok(!planIds(e, { select: { names: ['**'] } }).some((x) => x.startsWith('export:')));
  // tag, group (nested), project
  assert.deepEqual(planIds(e, { select: { tag: 'old' } }), ['canvas:marine_b']);
  assert.deepEqual(planIds(e, { select: { group: 'Armour' } }), ['canvas:marine_c']);
  assert.deepEqual(planIds(e, { select: { project: 'marines' } }), ['canvas:marine_a', 'canvas:marine_b', 'canvas:marine_c']);
  // graph relations
  assert.deepEqual(planIds(e, { select: { rel: { rel: 'rendered_from', to: 'model:rifle_v1' } } }), ['canvas:rifle_side']);
  assert.deepEqual(planIds(e, { select: { rel: { rel: 'variant_of', to: 'marine_a' } } }), ['canvas:marine_b']);
  assert.deepEqual(planIds(e, { select: { rel: { rel: 'rendered_from', to: 'rig:bob' } } }), ['canvas:bob']);
  // superseded = the replaced side
  assert.deepEqual(planIds(e, { select: { superseded: true } }), ['canvas:loose']);
  // orphans: no inbound edges, no project / group, not pinned
  const orph = planIds(e, { select: { orphans: true } });
  assert.ok(orph.includes('model:rifle_v1') === false, 'rifle_v1 has a render (inbound rendered_from)');
  assert.ok(orph.includes('canvas:rifle_side') && orph.includes('audio:blip') && orph.includes('model:crate'));
  assert.ok(!orph.includes('canvas:crate_tex'), 'a texture of a model is used');
  assert.ok(!orph.includes('canvas:marine_a'), 'project members are not orphans');
  fs.writeFileSync(path.join(e.home, 'ui-state.json'), JSON.stringify({ hidden: [], pinned: ['audio:blip'] }));
  assert.ok(!planIds(e, { select: { orphans: true } }).includes('audio:blip'), 'pinned assets are not orphans');
  // stale exports: the source asset is gone
  assert.deepEqual(planIds(e, { select: { stale_exports: true } }), []);
  e.run('cleanup_apply', { select: { ids: ['loose'] }, confirm: true });
  assert.deepEqual(planIds(e, { select: { stale_exports: true } }), ['export:weapons/rifle/loose.png']);
  // older_than / unused_since
  const d = e.docs.get('marine_c');
  d.updated = Date.now() - 40 * 86400000;
  assert.deepEqual(planIds(e, { select: { older_than: '30d', kind: 'canvas' } }), ['canvas:marine_c']);
  assert.deepEqual(planIds(e, { select: { unused_since: '30d', kind: 'canvas' } }), [], 'marine_c has a recent relation (group)');
  e.docs.get('marine_b').updated = Date.now() - 40 * 86400000;
  e.graph.data.edges.filter((x) => x.from === 'canvas:marine_b').forEach((x) => { x.ts = Date.now() - 50 * 86400000; });
  assert.deepEqual(planIds(e, { select: { unused_since: '30d', kind: 'canvas' } }), ['canvas:marine_b']);
  // union of selects; errors are actionable
  assert.deepEqual(planIds(e, { select: [{ tag: 'old' }, { ids: ['crate'] }] }), ['canvas:marine_b', 'model:crate']);
  assert.throws(() => plan(e, { select: { nmes: ['x'] } }), /unknown selector nmes/);
  assert.throws(() => plan(e, { select: {} }), /at least one selector/);
  assert.throws(() => plan(e, { select: { kind: 'spaceship' } }), /unknown kind "spaceship"/);
  assert.deepEqual(plan(e, { select: { ids: ['nope_nothing'] } }).unknown, ['nope_nothing']);
});

test('cleanup: dependencies block, include_dependents cascades, force overrides; soft users warn', () => {
  const { e } = workspace();
  // a texture used by a kept model
  const p1 = plan(e, { select: { ids: ['crate_tex'] } });
  assert.equal(p1.blocked_count, 1);
  assert.equal(p1.blocked[0].id, 'canvas:crate_tex');
  assert.match(p1.blocked[0].by[0], /model:crate \(depends_on\)/);
  assert.throws(() => e.run('cleanup_apply', { plan_id: p1.plan_id, confirm: true }), /refused, nothing removed: canvas:crate_tex: needed by model:crate/);
  assert.ok(e.docs.has('crate_tex'));
  // cascade
  const p2 = plan(e, { select: { ids: ['crate_tex'] }, include_dependents: true });
  assert.deepEqual(p2.items.map((x) => x.id).sort(), ['canvas:crate_tex', 'model:crate']);
  assert.equal(p2.items.find((x) => x.id === 'model:crate').reason, 'depends_on canvas:crate_tex');
  // the project palette used by kept canvases (part_of + uses_palette); compact form merges the rels
  const p3 = e.run('cleanup_plan', { select: { ids: ['project:marines'] } });
  assert.match(p3.blocked[0], /canvas:marine_a \(part_of, uses_palette\)/);
  // a rig is one asset: its parts canvas is never removed apart from it
  assert.deepEqual(planIds(e, { select: { ids: ['canvas:bob_parts'] } }), ['rig:bob']);
  // rendered sprites are soft users: warn, never block
  const p4 = plan(e, { select: { ids: ['rig:bob'] } });
  assert.equal(p4.blocked, undefined);
  assert.match(p4.warnings.join('\n'), /rig:bob <- rendered_from canvas:bob \(kept\)/);
  assert.deepEqual(planIds(e, { select: { ids: ['rig:bob'] }, include_dependents: 'all' }), ['canvas:bob', 'rig:bob']);
  // force
  const p5 = plan(e, { select: { ids: ['crate_tex'] }, force: true });
  assert.equal(p5.blocked, undefined);
  assert.match(p5.warnings[0], /forced: canvas:crate_tex is still needed by model:crate/);
  const r = e.run('cleanup_apply', { plan_id: p5.plan_id, confirm: true });
  assert.equal(r.removed, 1);
  assert.ok(!e.docs.has('crate_tex'));
  // apply without confirm is refused
  assert.throws(() => e.run('cleanup_apply', { select: { ids: ['loose'] } }), /confirm:true/);
});

test('cleanup: approved assets are protected, pinned ones warn', () => {
  const { e } = workspace();
  e.run('review_approve', { asset: 'loose' }, 'user');
  fs.writeFileSync(path.join(e.home, 'ui-state.json'), JSON.stringify({ hidden: [], pinned: ['canvas:marine_a'] }));
  const p = e.run('cleanup_plan', { select: { ids: ['loose', 'marine_a'] } });
  assert.deepEqual(p.blocked, ['canvas:loose: approved in review']);
  assert.match(p.next, /allow_approved:true/);
  assert.ok(p.warnings.includes('pinned: canvas:marine_a'));
  assert.throws(() => e.run('cleanup_apply', { plan_id: p.plan_id, confirm: true }), /approved in review/);
  const ok = e.run('cleanup_apply', { plan_id: p.plan_id, confirm: true, allow_approved: true });
  assert.equal(ok.removed, 2);
  // the pin goes to the trash with the asset and comes back on restore
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.home, 'ui-state.json'), 'utf8')).pinned, []);
  e.run('cleanup_restore', { ids: [ok.trash] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.home, 'ui-state.json'), 'utf8')).pinned, ['canvas:marine_a']);
  assert.ok(e.graph.data.nodes['canvas:loose'].approved, 'approval restored');
});

test('cleanup: export files only inside exports/ or a user allowlist (outside, traversal, symlinks refused)', () => {
  const { e, home } = workspace();
  const game = tmp('agent-art-game-');
  const outside = path.join(game, 'marine_b.png');
  e.run('export', { canvas: 'marine_b', path: outside });
  assert.ok(fs.existsSync(outside));
  // the export sits in a game folder that is not allowlisted: refused, the asset itself still goes
  const p = plan(e, { select: { ids: ['marine_b'] }, include_exports: true });
  assert.deepEqual(p.items.map((x) => x.id), ['canvas:marine_b']);
  assert.match(e.run('cleanup_plan', { select: { ids: ['marine_b'] }, include_exports: true }).refused_files[0], /marine_b\.png: outside the workspace exports folder and cleanup\.allow_paths/);
  // path traversal out of exports/ into the workspace internals or anywhere else
  const trav = e.run('cleanup_plan', { select: { ids: ['export:../canvases/marine_a.json'] } });
  assert.ok(!(trav.items || []).length);
  assert.match(trav.refused_files[0], /workspace internals/);
  const trav2 = e.run('cleanup_plan', { select: { ids: [`export:../../${path.basename(game)}/marine_b.png`] } });
  assert.match(trav2.refused_files[0], /outside the workspace exports folder/);
  // a link inside exports/ to a folder outside (a junction needs no admin rights on Windows)
  const linkDir = path.join(e.exportDir, 'linked');
  let linked = true;
  try { fs.symlinkSync(game, linkDir, 'junction'); } catch { linked = false; }
  if (linked) {
    const viaLink = e.run('cleanup_plan', { select: { ids: ['export:linked/marine_b.png'] } });
    assert.ok(!(viaLink.items || []).length, 'a file reached through a link that leaves exports/ is refused');
    assert.match(viaLink.refused_files[0], /outside the workspace exports folder/);
  }
  let fileLink = true;
  const target = path.join(e.exportDir, 'marine_a.png');
  try { fs.symlinkSync(target, path.join(e.exportDir, 'alias.png'), 'file'); } catch { fileLink = false; }
  if (fileLink) assert.match(e.run('cleanup_plan', { select: { ids: ['export:alias.png'] } }).refused_files[0], /symlink/);
  // only the user sets the allowlist; roots are refused
  assert.throws(() => e.run('cleanup_config', { allow_paths: [game] }, 'agent'), /set by the user/);
  assert.throws(() => e.run('cleanup_config', { allow_paths: [path.parse(game).root] }, 'user'), /root/);
  e.run('cleanup_config', { allow_paths: [game] }, 'user');
  assert.deepEqual(e.run('cleanup_config', {}).allow_paths, [path.resolve(game)]);
  const p2 = plan(e, { select: { ids: ['marine_b'] }, include_exports: true });
  assert.deepEqual(p2.items.map((x) => x.id).sort(), [`export:${outside.replace(/\\/g, '/')}`, 'canvas:marine_b'].sort());
  const bytes = fs.readFileSync(outside);
  const r = e.run('cleanup_apply', { plan_id: p2.plan_id, confirm: true });
  assert.ok(!fs.existsSync(outside));
  e.run('cleanup_restore', { ids: [r.trash] });
  assert.deepEqual(fs.readFileSync(outside), bytes, 'the game-folder export comes back to its original path');
  // the workspace internals stay refused even when a parent folder is allowlisted
  e.run('cleanup_config', { allow_paths: [path.dirname(home)] }, 'user');
  assert.match(e.run('cleanup_plan', { select: { ids: ['export:../canvases/marine_a.json'] } }).refused_files[0], /workspace internals/);
  if (linked) { try { fs.unlinkSync(linkDir); } catch { try { fs.rmdirSync(linkDir); } catch { /* temp folder */ } } }
});

test('cleanup: trash + restore round trip is byte identical (assets, graph, reviews, files)', () => {
  const { e, home } = workspace();
  e.run('graph_tag', { node: 'marine_a', add: ['hero'] });
  e.run('graph_note', { node: 'marine_a', note: 'old baked gun' });
  e.run('graph_group', { name: 'Old', members: ['marine_a', 'rifle_v1'] });
  e.run('graph_link', { from: 'marine_b', rel: 'variant_of', to: 'marine_a' });
  const rv = e.run('review_add', { asset: 'marine_a', region: [1, 1, 3, 3], note: 'muzzle too long', category: 'fix' }, 'user');
  e.run('review_add', { asset: 'marine_b', note: 'keep', category: 'question' }, 'user');
  e.flush();
  const files = [
    path.join(home, 'canvases', 'marine_a.json'), path.join(home, 'canvases', 'bob_parts.json'), path.join(home, 'models', 'rifle_v1.json'),
    path.join(home, 'audio', 'blip.json'), path.join(home, 'exports', 'marine_a.png'), path.join(home, 'reviews', `${rv.id}-0.png`),
  ].filter((f) => fs.existsSync(f));
  assert.ok(files.length >= 6, 'every kind has a file on disk');
  const before = new Map(files.map((f) => [f, fs.readFileSync(f)]));
  const snap = () => JSON.parse(JSON.stringify({ edges: e.graph.data.edges, nodes: e.graph.data.nodes, reviews: e.graph.data.reviews }));
  const graphBefore = snap();
  const sel = { ids: ['marine_a', 'rig:bob', 'canvas:bob', 'model:rifle_v1', 'rifle_side', 'audio:blip'] };
  const p = e.run('cleanup_plan', { select: sel, include_exports: true });
  const r = e.run('cleanup_apply', { plan_id: p.plan_id, confirm: true });
  assert.ok(r.removed >= 6);
  for (const f of files) assert.ok(!fs.existsSync(f), `${f} moved to the trash`);
  assert.ok(!e.docs.has('marine_a') && !e.docs.has('bob_parts') && !e.docs.has('rifle_side'));
  assert.ok(!e.graph.data.edges.some((x) => x.from === 'canvas:marine_a' || x.to === 'canvas:marine_a'));
  assert.ok(!e.graph.data.nodes['canvas:marine_a']);
  assert.equal(e.graph.data.reviews.length, 1);
  // logged: activity "removed" with the plan id, and the graph event log
  const act = e.activity.entries.find((x) => x.op === 'removed');
  assert.equal(act.plan, p.plan_id);
  assert.match(act.summary, new RegExp(p.plan_id));
  assert.equal(e.graph.data.events.at(-1).type, 'removed');
  assert.equal(e.graph.data.events.at(-1).plan, p.plan_id);
  // the trash lists it; restore puts everything back
  const t = e.run('cleanup_trash', {});
  assert.equal(t.trash[0].id, r.trash);
  const back = e.run('cleanup_restore', { ids: [r.trash] });
  assert.equal(back.restored, r.removed);
  for (const [f, buf] of before) assert.deepEqual(fs.readFileSync(f), buf, `${path.basename(f)} is byte identical`);
  assert.deepEqual(snap(), graphBefore, 'graph edges (same order), tags, notes and review notes are back');
  assert.ok(e.docs.has('marine_a') && e.docs.has('bob_parts') && e.docs.has('bob') && e.models.has('rifle_v1'));
  assert.ok(e.graph.exists('rig:bob'));
  assert.ok(e.audio.defs.has('blip'));
  // a fresh process sees the restored workspace (the files are the truth)
  e.flush();
  const again = new Engine({ home });
  assert.ok(again.docs.has('marine_a'));
  assert.match(again.run('graph_query', { node: 'marine_a' }).text, /#hero "old baked gun"/);
  assert.equal(again.run('cleanup_trash', {}).batches, 0, 'restored batches drop out of the trash list');
  // a single asset of a batch can come back alone; a re-created name is a conflict, never overwritten
  const r2 = e.run('cleanup_apply', { select: { ids: ['marine_c', 'loose'] }, confirm: true });
  e.run('create', { name: 'loose', width: 4 });
  const back2 = e.run('cleanup_restore', { ids: ['canvas:marine_c', 'canvas:loose'] });
  assert.deepEqual(back2.items, ['canvas:marine_c']);
  assert.match(back2.conflicts[0], /canvas:loose: exists again/);
  assert.equal(e.docs.get('loose').width, 4);
  assert.equal(e.run('cleanup_trash', {}).trash[0].id, r2.trash);
});

test('cleanup: manifest pruning and restore', () => {
  const { e } = workspace();
  const man = path.join(e.exportDir, 'manifest.json');
  const orig = JSON.stringify({ version: 2, sprites: { marine_a: { file: 'marine_a.png', w: 8 }, loose: { file: 'weapons/rifle/loose.png' } }, list: ['x'] }, null, 2) + '\n';
  fs.writeFileSync(man, orig);
  // auto: entries that name a removed export file
  const p = e.run('cleanup_plan', { select: { ids: ['marine_a'] }, include_exports: true, prune_manifest: { file: 'manifest.json' } });
  assert.deepEqual(p.manifest.first, ['sprites.marine_a']);
  const r = e.run('cleanup_apply', { plan_id: p.plan_id, confirm: true });
  assert.match(r.manifest, /1 entry pruned/);
  const pruned = JSON.parse(fs.readFileSync(man, 'utf8'));
  assert.deepEqual(Object.keys(pruned.sprites), ['loose']);
  e.run('cleanup_restore', { ids: [r.trash] });
  assert.equal(fs.readFileSync(man, 'utf8'), orig, 'untouched since: the original bytes come back');
  // explicit keys; the manifest changed after pruning: the entries are merged back, the edit is kept
  const r2 = e.run('cleanup_apply', { select: { ids: ['loose'] }, include_exports: true, prune_manifest: { file: 'manifest.json', keys: ['sprites.loose', 'list'] }, confirm: true });
  const j = JSON.parse(fs.readFileSync(man, 'utf8'));
  assert.equal(j.sprites.loose, undefined);
  assert.equal(j.list, undefined);
  j.added = true;
  fs.writeFileSync(man, JSON.stringify(j, null, 2));
  const back = e.run('cleanup_restore', { ids: [r2.trash] });
  assert.match(back.manifests[0], /merged/);
  const m2 = JSON.parse(fs.readFileSync(man, 'utf8'));
  assert.deepEqual(m2.sprites.loose, { file: 'weapons/rifle/loose.png' });
  assert.deepEqual(m2.list, ['x']);
  assert.equal(m2.added, true);
  // a manifest outside the allowed paths is refused
  const game = tmp('agent-art-game-');
  fs.writeFileSync(path.join(game, 'm.json'), '{}');
  assert.throws(() => e.run('cleanup_plan', { select: { ids: ['marine_b'] }, prune_manifest: { file: path.join(game, 'm.json') } }), /outside the workspace exports folder/);
});

test('cleanup: empty is the only hard delete', () => {
  const { e, home } = workspace();
  const trashDir = path.join(home, 'trash');
  const calls = [];
  const orig = { rmSync: fs.rmSync, unlinkSync: fs.unlinkSync, rmdirSync: fs.rmdirSync };
  for (const k of Object.keys(orig)) fs[k] = function (p, ...rest) { calls.push([k, String(p)]); return orig[k].call(this, p, ...rest); };
  let batch;
  try {
    batch = e.run('cleanup_apply', { select: { ids: ['marine_a', 'model:rifle_v1', 'rifle_side', 'audio:blip'] }, include_exports: true, confirm: true }).trash;
    e.run('cleanup_restore', { ids: [batch] });
    // single-item deletes go to the trash too
    assert.match(e.run('delete', { canvas: 'marine_b' }).trash, /^t/);
    assert.match(e.run('model_delete', { name: 'crate' }).trash, /^t/);
    assert.match(JSON.stringify(e.run('audio_delete', { name: 'blip' })), /blip/);
    e.run('project_create', { name: 'tmpproj' });
    assert.match(e.run('project_delete', { name: 'tmpproj' }).trash, /^t/);
    assert.deepEqual(calls, [], 'apply, restore and single deletes never delete a file');
    assert.throws(() => e.run('cleanup_empty', {}), /confirm:true/);
    assert.deepEqual(calls, []);
  } finally { Object.assign(fs, orig); }
  const t = e.run('cleanup_trash', {});
  assert.ok(t.batches >= 4);
  assert.ok(t.trash.some((b) => b.via === 'art_canvas delete' && b.first[0] === 'canvas:marine_b'));
  // single deletes restore like any batch
  e.run('cleanup_restore', { ids: ['canvas:marine_b', 'model:crate', 'audio:blip', 'project:tmpproj'] });
  assert.ok(e.docs.has('marine_b') && e.models.has('crate') && e.audio.defs.has('blip') && e.projects.has('tmpproj'));
  // empty older_than keeps recent batches; empty all removes them for good
  e.run('delete', { canvas: 'marine_b' });
  assert.equal(e.run('cleanup_empty', { older_than: '1d', confirm: true }).emptied, 0);
  const em = e.run('cleanup_empty', { confirm: true, all: true });
  assert.ok(em.emptied >= 1);
  assert.equal(e.run('cleanup_trash', { all: true }).batches, 0);
  assert.ok(fs.readdirSync(trashDir).every((f) => !fs.statSync(path.join(trashDir, f)).isDirectory()));
  assert.throws(() => e.run('cleanup_restore', { ids: ['canvas:marine_b'] }), /nothing to restore/);
  // trash_deletes:false = the old hard delete
  e.run('cleanup_config', { trash_deletes: false }, 'user');
  assert.equal(e.run('delete', { canvas: 'marine_c' }).trash, undefined);
  assert.equal(e.run('cleanup_trash', {}).batches, 0);
});

test('cleanup: compact output stays bounded; full returns everything', () => {
  const e = new Engine({ home: tmp() });
  for (let i = 0; i < 300; i++) e.run('create', { name: `old_sprite_${String(i).padStart(3, '0')}`, width: 4 });
  e.flush();
  const p = e.run('cleanup_plan', { select: { names: ['old_sprite_*'] } });
  assert.equal(p.remove.count, 300);
  assert.equal(p.items.length, 10);
  assert.equal(p.more, 290);
  assert.ok(JSON.stringify(p).length < 1200, `plan reply ${JSON.stringify(p).length} chars`);
  assert.equal(e.run('cleanup_plan', { select: { names: ['old_sprite_*'] }, limit: 3 }).items.length, 3);
  assert.equal(e.run('cleanup_plan', { select: { names: ['old_sprite_*'] }, full: true }).items.length, 300);
  const r = e.run('cleanup_apply', { plan_id: p.plan_id, confirm: true });
  assert.equal(r.removed, 300);
  assert.ok(JSON.stringify(r).length < 800, `apply reply ${JSON.stringify(r).length} chars`);
  assert.ok(JSON.stringify(e.run('cleanup_trash', {})).length < 800);
  assert.ok(JSON.stringify(e.run('cleanup_usage', {})).length < 1200);
  const back = e.run('cleanup_restore', { all: true });
  assert.equal(back.restored, 300);
  assert.ok(JSON.stringify(back).length < 800);
  assert.equal(e.docs.size, 300);
});

test('cleanup: replace records the supersession, moves edges and open notes, then plans the old side', () => {
  const { e } = workspace();
  e.run('graph_group', { name: 'Marines', members: ['marine_a'] });
  e.run('graph_link', { from: 'marine_b', rel: 'variant_of', to: 'marine_a' });
  e.run('graph_tag', { node: 'marine_a', add: ['hero'] });
  const open = e.run('review_add', { asset: 'marine_a', note: 'fix the visor', category: 'fix' }, 'user');
  const closed = e.run('review_add', { asset: 'marine_a', note: 'old', category: 'fix' }, 'user');
  e.run('review_update', { id: closed.id, status: 'accepted' }, 'user');
  e.run('create', { name: 'marine_v2', width: 8 });
  const r = e.run('cleanup_replace', { old: 'marine_a', new: 'marine_v2' });
  assert.match(r.text, /canvas:marine_v2 replaces canvas:marine_a: 2 edge\(s\) and 1 open review note\(s\) moved/);
  assert.ok(e.graph.data.edges.some((x) => x.from === 'canvas:marine_v2' && x.rel === 'replaces' && x.to === 'canvas:marine_a'));
  assert.ok(e.graph.data.edges.some((x) => x.from === 'canvas:marine_v2' && x.rel === 'part_of' && x.to === 'group:Marines'));
  assert.ok(e.graph.data.edges.some((x) => x.from === 'canvas:marine_b' && x.rel === 'variant_of' && x.to === 'canvas:marine_v2'));
  assert.equal(e.graph.data.reviews.find((x) => x.id === open.id).asset, 'canvas:marine_v2');
  assert.equal(e.graph.data.reviews.find((x) => x.id === closed.id).asset, 'canvas:marine_a', 'resolved notes stay as history');
  assert.deepEqual(e.graph.data.nodes['canvas:marine_a'].tags, ['hero'], 'tags stay on the old asset');
  assert.equal(e.graph.data.nodes['canvas:marine_v2'], undefined);
  assert.equal(e.graph.data.nodes['canvas:marine_a'].superseded.by, 'canvas:marine_v2');
  // badges: graph JSON + flags op
  const node = e.graph.toJSON().nodes.find((x) => x.id === 'canvas:marine_a');
  assert.equal(node.superseded, true);
  assert.ok(e.run('cleanup_flags').superseded.includes('canvas:marine_a'));
  const idx = assetIndex(e);
  assert.ok(idx.flags.superseded.includes('canvas:marine_a') && idx.flags.orphans.includes('audio:blip'));
  assert.deepEqual(idx.tags['canvas:marine_a'], ['hero']);
  // the superseded side is ready for cleanup (with its export)
  const p = e.run('cleanup_plan', { select: { superseded: true }, include_exports: true, full: true });
  assert.deepEqual(p.items.map((x) => x.id).sort(), ['canvas:marine_a', 'export:marine_a.png']);
  assert.throws(() => e.run('cleanup_replace', { old: 'marine_a', new: 'marine_a' }), /same asset/);
});

test('cleanup: art_cleanup tool via MCP runTool; usage reports kinds, projects, groups, biggest', async () => {
  const { e } = workspace();
  e.run('graph_group', { name: 'Old', members: ['marine_a', 'crate'] });
  const call = (op, a) => e.run(op, a, 'agent');
  const json = async (a) => JSON.parse((await runTool('art_cleanup', a, call))[0].text);
  const u = await json({ action: 'usage' });
  assert.match(u.by_kind.canvas, /^\d+ · /);
  assert.ok(u.by_project.marines && u.by_group.Old && u.biggest.length <= 10 && u.other.trash);
  const p = await json({ action: 'plan', select: { names: ['marine_*'] } });
  assert.equal(p.remove.count, 3);
  const r = await json({ action: 'apply', plan_id: p.plan_id, confirm: true });
  assert.equal(r.removed, 3);
  assert.equal((await json({ action: 'trash' })).batches, 1);
  assert.equal((await json({ action: 'restore', ids: [r.trash] })).restored, 3);
  const rep = (await runTool('art_cleanup', { action: 'replace', old: 'marine_a', new: 'marine_b' }, call))[0].text;
  assert.match(rep, /replaces/);
  await assert.rejects(() => runTool('art_cleanup', { action: 'config', allow_paths: ['/tmp'] }, call), /set by the user/);
  assert.deepEqual(touchedAssets('art_cleanup', { old: 'x', new: 'y' }), []);
  assert.match((await runTool('art_help', { topic: 'cleanup' }, call))[0].text, /CLEANUP \(art_cleanup\)/);
});

test('cleanup: a registered asset type plugs into the graph and cleanup (registration hook)', () => {
  const home = tmp();
  const dir = path.join(home, 'planets');
  const store = new Map();
  const load = () => { store.clear(); if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); store.set(p.name, p); } };
  registerAssetType('planet', {
    sub: ['planetlayer'],
    list: () => [...store.keys()],
    info: (_e, n) => ({ project: store.get(n)?.project, updated: store.get(n)?.updated }),
    files: (_e, n) => [path.join(dir, `${n}.json`)],
    unload: (_e, n) => store.delete(n),
    reload: (_e, n) => { const p = JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8')); store.set(p.name, p); },
    edges: (_e, add) => { for (const p of store.values()) if (p.texture) add(`planet:${p.name}`, 'depends_on', `canvas:${p.texture}`); },
  });
  const e = new Engine({ home });
  e.run('create', { name: 'mars_tex', width: 8 });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mars.json'), JSON.stringify({ name: 'mars', texture: 'mars_tex', updated: Date.now() }));
  load();
  e.graph.cache = null;
  // graph: resolvable by bare name and kind, derived edges, query
  assert.equal(e.graph.resolve('mars'), 'planet:mars');
  assert.ok(e.graph.exists('planet:mars'));
  assert.match(e.run('graph_query', { node: 'planet:mars' }).text, /depends_on> canvas:mars_tex/);
  e.run('graph_tag', { node: 'planet:mars', add: ['space'] });
  e.run('graph_link', { from: 'planetlayer:mars/clouds', rel: 'variant_of', to: 'mars_tex' });
  // cleanup: the texture is blocked by the planet; the planet selects by kind, tag; round trip
  assert.match(e.run('cleanup_plan', { select: { ids: ['mars_tex'] } }).blocked[0], /planet:mars \(depends_on\)/);
  assert.deepEqual(planIds(e, { select: { kind: 'planet' } }), ['planet:mars']);
  assert.deepEqual(planIds(e, { select: { tag: 'space' } }), ['planet:mars']);
  const bytes = fs.readFileSync(path.join(dir, 'mars.json'));
  const r = e.run('cleanup_apply', { select: { kind: 'planet' }, confirm: true });
  assert.ok(!store.has('mars') && !fs.existsSync(path.join(dir, 'mars.json')));
  assert.ok(!e.graph.data.edges.some((x) => x.from === 'planetlayer:mars/clouds'), 'sub-node edges go with the owner');
  e.run('cleanup_restore', { ids: [r.trash] });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'mars.json')), bytes);
  assert.ok(store.has('mars'));
  assert.ok(e.graph.data.edges.some((x) => x.from === 'planetlayer:mars/clouds'));
  assert.deepEqual(e.graph.data.nodes['planet:mars'].tags, ['space']);
});
