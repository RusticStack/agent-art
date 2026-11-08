// Asset type registry: the one hook that lets a kind of asset take part in the asset graph and in
// cleanup (art_cleanup: plan / apply / trash / restore / usage / replace) without per-type code
// anywhere else. Built-in kinds (canvas, rig, model, audio, project, export) register themselves in
// cleanup.js; a new kind (planets, ships, anim sets, ...) registers itself from its own module:
//
//   import { registerAssetType } from './assettypes.js';
//   registerAssetType('planet', {
//     list: (engine) => [...planets(engine).keys()],              // names of every asset of this kind
//     files: (engine, name) => [path.join(dir(engine), `${name}.json`)], // every file that makes it up
//     unload: (engine, name) => planets(engine).delete(name),      // files are already in the trash
//     reload: (engine, name) => loadPlanet(engine, name),          // files are back: load it again
//     info: (engine, name) => ({ project, updated }),              // optional: selectors + usage
//     edges: (engine, add) => { add('planet:x', 'depends_on', 'canvas:x_tex'); }, // optional derived graph edges
//   });
//
// The module only has to be imported before the workspace is used (engine.js imports the built-in
// ones). Ids are "<kind>:<name>"; sub-assets are "<subkind>:<owner>/<part>" (see `sub`).
const TYPES = new Map();

/**
 * spec:
 *  list(engine) -> iterable of names                     required
 *  files(engine, name) -> [absolute paths]               required for removal (missing files are skipped)
 *  unload(engine, name, source)                          required for removal: forget it in memory
 *  reload(engine, name, source)                          required for restore: load it from its files
 *  exists(engine, name) -> bool                          default: list() includes name
 *  info(engine, name) -> {project?, updated?, created?}  optional (project / older_than selectors, usage)
 *  edges(engine, add)                                    optional: add(from, rel, to, attrs?) derived graph edges
 *  container: true                                       part_of edges INTO it are hard dependencies (project)
 *  sub: ['planetlayer']                                  sub-node kinds owned by it (planetlayer:<name>/<x>)
 *  flush(engine, name)                                   optional: write pending in-memory changes to files
 *  removable: false                                      graph-only kind (listed, never removed)
 */
export function registerAssetType(kind, spec) {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(kind || '')) throw new Error(`asset kind "${kind}" must be 1-24 chars a-z 0-9 _`);
  if (!spec || typeof spec.list !== 'function') throw new Error(`asset type "${kind}" needs list(engine)`);
  TYPES.set(kind, { kind, ...spec });
  return TYPES.get(kind);
}
export const assetType = (kind) => TYPES.get(kind) || null;
export const assetTypes = () => [...TYPES.values()];
/** Sub-node kind -> owner kind ("layer" -> "canvas"). */
export function subOwnerKind(kind) {
  for (const t of TYPES.values()) if (t.sub?.includes(kind)) return t.kind;
  return null;
}
