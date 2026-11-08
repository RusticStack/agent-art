// art_model actions for ships and structures: kit (paint the sci-fi kit texture canvases), livery
// (paint a hull livery canvas: paint masks, stripes, hazard, decals, faction mark, wear), generate
// (interior from a ship hull | mining_colony | market) and budget (triangles, LOD estimate, draw
// calls, class verdict).
import { Doc, Layer } from './doc.js';
import { paintKitTextures, paintLivery } from './shipgen.js';
import { interiorFromHull, miningColony, marketDistrict } from './layoutgen.js';
import { expandDef } from './kitparts.js';
import { budgetReport, SCALE_CLASSES } from './modelkit.js';
import { walkAnalyze } from './walk.js';

/** Assemblies that open: walk_check builds them open (static, unnamed) to test passages. */
const OPENABLE = new Set(['door', 'ramp', 'cargo_door', 'canopy', 'ring_door', 'airlock']);

const NAME_RE = /^[A-Za-z0-9_\-.]{1,64}$/;

export function kitOps({ getModel, saveModel, build, models }) {
  return {
    /** art_model kit {prefix?:"kit", colors?, seed?, overwrite?}: paint the kit texture canvases. */
    model_kit(a, source) {
      const prefix = a.prefix ?? 'kit';
      if (!/^[A-Za-z0-9_]{1,24}$/.test(prefix)) throw new Error('kit prefix must be 1-24 letters, digits or _');
      const set = paintKitTextures({ prefix, colors: a.colors || {}, seed: a.seed ?? 1 });
      const made = [], kept = [];
      for (const [name, t] of Object.entries(set)) {
        if (this.docs.has(name) && !a.overwrite) { kept.push(name); continue; }
        if (this.docs.has(name)) this.run('delete', { canvas: name }, source);
        const d = new Doc({ name, width: t.w, height: t.h });
        d.layers[0].name = 'color';
        d.layers[0].data.set(t.color);
        for (const k of ['height', 'metal', 'rough', 'emissive']) {
          if (!t[k] || (k === 'height' && name.endsWith('_glow'))) continue;
          const l = new Layer(k, t.w, t.h, t[k]);
          if (k !== 'emissive') l.visible = false;
          d.layers.push(l);
        }
        d.meta = { kit: prefix, ...(name.endsWith('_glass') ? { material: 'glass' } : {}) };
        this.attach(d);
        this.changed(d, { op: 'kit', source, label: 'kit texture', structural: true });
        made.push(name);
      }
      if (!this.docs.has(`${prefix}_trim`)) this.run('model_trim', { canvas: `${prefix}_trim` }, source);
      return { canvases: made, kept, trim: `${prefix}_trim`, use: 'ship templates: textures:"kit"; kit pieces: textures:{floor:"kit_deck", wall:"kit_wall", ...}; screens: console {textures:{screen:"kit_screen"}}; wear overlay: overlays:[{texture:"kit_scratches", where:"edges"}]' };
    },
    /** art_model livery {name:<ship model>, part?:<hull id|name>, canvas, primary, secondary, stripes, hazard, decals, mark, wear, apply?:true}. */
    model_livery(a, source) {
      const def = getModel(this, a.name), x = expandDef(def);
      const hulls = x.parts.filter((p) => p && p.type === 'hull');
      const H = a.part !== undefined ? hulls.find((p) => p.id === a.part || p.name === a.part) : hulls[0];
      if (!H) throw new Error(`livery: model "${a.name}" has no hull part${a.part !== undefined ? ` "${a.part}"` : ''} (hull ids: ${hulls.map((h) => h.id ?? h.name).join(', ') || 'none'})`);
      const canvas = a.canvas ?? `${a.name}_livery`;
      if (!NAME_RE.test(canvas)) throw new Error('livery canvas name must be 1-64 letters, digits, _ - .');
      if (this.docs.has(canvas) && !a.overwrite) throw new Error(`Canvas "${canvas}" exists (overwrite:true repaints it)`);
      const r = paintLivery(H, a);
      if (this.docs.has(canvas)) this.run('delete', { canvas }, source);
      const d = new Doc({ name: canvas, width: r.width, height: r.height });
      d.layers[0].name = 'color';
      d.layers[0].data.set(r.color);
      const hl = new Layer('height', r.width, r.height, r.height_layer); hl.visible = false; d.layers.push(hl);
      d.meta = { livery: { model: a.name, hull: H.id ?? H.name ?? null, map: 'x = around from the top centre (u), y = nose (top row) .. tail' }, material: 'painted_metal' };
      this.attach(d);
      this.changed(d, { op: 'livery', source, label: 'livery', structural: true });
      let applied = false;
      if (a.apply !== false) {
        // point the raw hull part at the livery (fit UVs); template parts keep their names / ids
        const parts = def.parts.map((p) => (p && p.type === 'hull' && (p === H || (H.id !== undefined && p.id === H.id) || (H.name && p.name === H.name)) ? { ...p, texture: canvas, uv: 'fit' } : p));
        if (parts.some((p, i) => p !== def.parts[i])) { saveModel(this, { ...def, parts }, source, `livery ${canvas}`); applied = true; }
      }
      return { canvas, size: `${r.width}x${r.height}`, applied, next: applied ? `art_model preview {name:"${a.name}", views:["game","side"], mood:true}` : `set the hull part {texture:"${canvas}", uv:"fit"}` };
    },
    /**
     * art_model generate {kind:"interior", name:<new model>, hull:<ship model>, part?, seed?, windows?:true}
     * | {kind:"mining_colony"|"market", name, seed?, ...}: writes the model(s) and returns the report.
     */
    model_generate(a, source) {
      const kind = a.kind;
      if (!NAME_RE.test(a.name || '')) throw new Error('generate needs name: "<new model>"');
      const exists = (n) => models(this).has(n);
      if (exists(a.name) && !a.overwrite) throw new Error(`Model "${a.name}" exists (overwrite:true replaces it and its kit pieces)`);
      const save = (d, label) => { d.created = d.created ?? Date.now(); saveModel(this, d, source, label); };
      if (kind === 'interior') {
        const shipName = a.hull ?? a.ship;
        const ship = getModel(this, shipName), x = expandDef(ship);
        const hulls = x.parts.filter((p) => p && p.type === 'hull');
        const H = a.part !== undefined ? hulls.find((p) => p.id === a.part || p.name === a.part) : hulls[0];
        if (!H) throw new Error(`interior: "${shipName}" has no hull part`);
        const built = build(this, ship);
        const doors = (built.markers || []).filter((m) => m.kind === 'door');
        const r = interiorFromHull(a.name, H, doors, { ...a, ship: shipName });
        save(r.def, 'interior generated');
        let windows = 0;
        // merge:true (default) also writes the interior into the ship itself (one model, parts tagged
        // inside:<hull>, so walk_check checks the fit); the standalone interior model stays for cull exports
        const merge = a.merge !== false, key = H.id ?? H.name ?? 0;
        if ((a.windows !== false && r.windows.length) || merge) {
          const keep = ship.parts.filter((p) => !(p && (p.auto === 'interior' || p.auto === 'interior_merge')));
          const inner = merge ? r.def.parts.map((p) => ({ ...p, auto: 'interior_merge', inside: key, ...(ship.parts.some((q) => q && q.name === 'hull') ? { parent: 'hull' } : {}) })) : [];
          save({ ...ship, parts: [...keep, ...(a.windows !== false ? r.windows : []), ...inner] }, merge ? 'interior merged' : 'interior windows');
          windows = a.windows !== false ? r.windows.length : 0;
        }
        const ib = build(this, r.def);
        return { model: a.name, ship: shipName, merged_into_ship: a.merge !== false, triangles: ib.mesh.triangles, ...r.report, windows_on_ship: windows, next: `art_model preview {name:"${a.name}", views:["top","iso"], mood:true}; export {name:"${a.name}"} (cull rooms + auto portals)` };
      }
      if (kind === 'mining_colony' || kind === 'colony' || kind === 'market') {
        const r = kind === 'market' ? marketDistrict(a.name, a) : miningColony(a.name, a);
        for (const m of r.models) save(m, 'kit piece generated');
        save(r.def, `${kind} generated`);
        const b = build(this, r.def, { instances: true });
        const inst = b.instances.reduce((s, it) => s + it.mesh.triangles, 0);
        return { model: a.name, kit_model_names: r.models.map((m) => m.name), triangles: b.mesh.triangles + inst, triangles_root: b.mesh.triangles, triangles_instanced: inst, ...r.report, next: `art_model export {name:"${a.name}", instances:true, collision:"boxes"}` };
      }
      throw new Error('generate kind must be interior (with hull:<ship model>), mining_colony or market');
    },
    /**
     * art_model walk_check {name}: walkability report against the player metrics (blocked doors,
     * headroom, unreachable areas, floor gaps, interior parts poking through the hull, metric
     * violations). Doors / ramps / canopies / airlocks are opened for the passage tests.
     */
    model_walk_check(a) {
      const def = getModel(this, a.name);
      const openDef = { ...def, parts: def.parts.map((p) => { if (!p || !OPENABLE.has(p.type)) return p; const q = { ...p, open: 1, inner_open: 1, outer_open: 1 }; delete q.name; return q; }) };
      const closed = build(this, def), open = build(this, openDef);
      const x = expandDef(def);
      const hulls = [];
      for (const H of x.parts.filter((p) => p && p.type === 'hull' && (p.shell || p.openings))) {
        const key = H.id ?? H.name;
        const inner = def.parts.filter((p) => p && p.inside !== undefined && p.inside === key).map((p) => { const q = { ...p }; delete q.parent; delete q.name; return q; });
        hulls.push({ part: H, interior: inner.length ? build(this, { name: `${def.name}__interior`, parts: inner, grid: def.grid, scale: def.scale, origin: 'parts' }).mesh : null });
      }
      const r = walkAnalyze({ markers: open.markers || [], closed: closed.mesh, open: open.mesh, hulls, scale: Number(def.scale ?? 32) });
      return { model: def.name, ...r, next: r.ok ? `art_model export {name:"${def.name}", walk:true} (navmesh + colliders + triggers)` : 'fix the listed problems (positions in metres), then walk_check again' };
    },
    /** art_model budget {name, class?, lods?}: triangle / draw-call / LOD report against a scale class. */
    model_budget(a) {
      const def = getModel(this, a.name);
      const built = build(this, def, { instances: true });
      if (a.class !== undefined && !SCALE_CLASSES[a.class]) throw new Error(`class must be one of ${Object.keys(SCALE_CLASSES).join(', ')}`);
      return { model: def.name, ...budgetReport(def, { ...built, def: built.def ?? def }, { cls: a.class, scale: Number(def.scale ?? 32), lods: a.lods }) };
    },
  };
}
