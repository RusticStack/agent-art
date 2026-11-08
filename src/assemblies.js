// Registry of art_model kit assemblies (kitparts.js ship parts, kitrooms.js rooms / structures).
// No imports, so every module can register into it whatever the import order.
/** name -> (p, k) => {parts, sockets?, clips?, poses?}. k = {node(piece) | null, rig, grid, rnd, id, hullOf, surface}. */
export const ASSEMBLIES = {};
/** name -> one-line parameter doc. */
export const ASSEMBLY_DOCS = {};
export function registerAssembly(name, fn, doc) { ASSEMBLIES[name] = fn; ASSEMBLY_DOCS[name] = doc; }
