// MCP (Model Context Protocol) stdio server exposing the pixel-art engine as tools.
// If an Agent Art server is already running on the port, this process proxies to it
// (so every session draws into the same live UI); otherwise it hosts engine + UI itself.
//
// Token budget: tool definitions are sent with every request, so they stay terse. Details,
// recipes and examples are served on demand (art_help, MCP prompts/resources, error hints).
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Engine } from './engine.js';
import { startServer, APP_ID, packResult } from './server.js';
import { COMMAND_NAMES } from './doc.js';
import { drawDescription, helpText, TOPICS } from './docs.js';
import { SKILLS, skillText } from './skills.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const log = (...a) => process.stderr.write(`[agent-art] ${a.join(' ')}\n`);

export const INSTRUCTIONS = `Agent Art: pixel-art editor for agents (sprites, tiles, textures, icons, UI, animations, 2.5D scenes, game assets). The user watches live in a web UI (art_open_ui).
Workflow: palette ramps first (art_palette ramp) -> flat silhouettes -> shade (auto form shading) -> outline -> hand detail (grid) -> art_critique -> fix -> art_view.
Multi-asset work: art_project create (shared palette + style notes), review with art_sheet. Any character/creature with more than one view or frame: use art_rig (template:"humanoid"|"humanoid_hd" (detailed 64x96+)|"blob"|"flyer" is fastest; templates are only defaults) instead of hand-drawing frames, so every frame stays the same asset.
3D (HD-2D maps, props -> .glb): art_model.
Audio (SFX, music, mixing; you cannot hear, so read analyze/critique reports): art_audio.
Details on demand: art_help {topic: workflow|textures|characters|animation|rig|scenes|hires|minecraft|3d|audio|music|mixing|perception} or {op:"<draw command>"}.`;

const S = {
  canvas: { type: 'string' },
  layer: { type: ['string', 'integer'], description: 'name or index (default active)' },
  frame: { type: 'integer' },
};
const region = { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } };
/** art_model part: placement / material options (builder args are open: art_help {topic:"3d"}). */
const MODEL_PART = {
  type: 'object',
  properties: {
    type: { type: 'string' }, pivot: { type: 'array', description: '[x,y,z] rotate about' }, mirror: { type: ['string', 'array'], description: 'x|y|z|[..]' },
    opacity: { type: 'number', minimum: 0, maximum: 1 }, glass: { type: ['boolean', 'object'] }, plane: { enum: ['xy', 'xz', 'zy'] },
  },
  required: ['type'],
};
const BLENDS = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten', 'soft-light'];

export const TOOLS = [
  {
    name: 'art_create_canvas',
    description: 'Create a canvas (transparent unless background). frames>1 = animation strip of equal frames. project = inherit its palette.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, width: { type: 'integer', default: 16 }, height: { type: 'integer', description: 'frame height (default width)' },
        frames: { type: 'integer' }, background: { type: 'string' }, palette: { type: 'object', additionalProperties: { type: 'string' } },
        project: { type: 'string' }, meta: { type: 'object', description: 'e.g. {"texture":"blocks/stone"}' }, overwrite: { type: 'boolean' },
      },
      required: ['name'],
    },
    run: (call, a) => call('create', a),
  },
  {
    name: 'art_list',
    description: 'List canvases (optionally of a project), projects and the UI URL.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
    run: (call, a) => call('list', a),
  },
  {
    name: 'art_info',
    description: 'Canvas details: size, frames, layers, palette, animations, colors used.',
    inputSchema: { type: 'object', properties: { canvas: S.canvas, color_limit: { type: 'integer' } }, required: ['canvas'] },
    run: (call, a) => call('info', a),
  },
  {
    name: 'art_draw',
    description: drawDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas,
        commands: { type: 'array', minItems: 1, items: { type: 'object', properties: { op: { type: 'string', enum: COMMAND_NAMES } }, required: ['op'], additionalProperties: true } },
        commands_file: { type: 'string' },
        layer: S.layer, frame: S.frame,
        label: { type: 'string', description: 'shown in the UI log' },
        preview: { type: 'boolean', description: 'also return an image of the result' },
        critique: { type: 'boolean', description: 'also return the art_critique summary' },
      },
      required: ['canvas'],
    },
    run: async (call, a) => {
      const { preview, critique, ...rest } = a;
      const r = await call('draw', rest);
      if (critique) {
        const c = await call('critique', { canvas: a.canvas, frame: a.frame });
        r.critique = { score: c.score, issues: (c.issues || []).map((i) => `${i.id}: ${i.message}`) };
      }
      if (!preview) return r;
      const v = await call('render', { canvas: a.canvas, frame: a.frame, max_size: 384 });
      return { ...r, image: v.image, scale: v.scale };
    },
  },
  {
    name: 'art_view',
    description: 'See the canvas as an image (checker = transparent; grid when zoomed). tile:3 = seam check; frame+onion for animation; x,y,w,h zooms; big canvases come back as a downsampled overview.',
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas, scale: { type: 'integer' }, max_size: { type: 'integer', description: 'default 512 px' }, tile: { type: 'integer' }, grid: { type: 'boolean' },
        layer: S.layer, frame: S.frame, onion: { type: 'integer' }, background: { type: 'string' }, guide: { type: 'string', description: '"grid:16", "iso:32", "center"' },
        tint: { type: 'string' }, apply_tint: { type: 'boolean' }, ...region,
      },
      required: ['canvas'],
    },
    run: (call, a) => call('render', a),
  },
  {
    name: 'art_critique',
    description: 'Automatic pixel-art review: noise/stray pixels, contrast, color count, tiling seams, outline, pillow shading, jaggies, and animation consistency (size drift, ground line, palette drift). Returns issues with coordinates and fixes. Use after drawing, before exporting.',
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas, kind: { type: 'string', enum: ['auto', 'texture', 'sprite', 'scene'] }, frame: S.frame, animation: { type: 'string' },
        layer: S.layer, tileable: { type: 'boolean' }, max_colors: { type: 'integer' }, all_frames: { type: 'boolean' },
      },
      required: ['canvas'],
    },
    run: (call, a) => call('critique', a),
  },
  {
    name: 'art_help',
    description: 'Docs on demand: {op:"shade"} full options + example for a draw command; {topic} guides: workflow, textures, characters, animation, rig, scenes, hires, minecraft, 3d, audio, music, mixing, perception; {skill} step-by-step recipes.',
    inputSchema: {
      type: 'object',
      properties: { op: { type: 'string' }, topic: { type: 'string', enum: ['index', 'ops', ...Object.keys(TOPICS)] }, skill: { type: 'string', enum: Object.keys(SKILLS) } },
    },
    run: async (call, a) => ({ text: a.skill ? skillText(a.skill) : helpText(a) }),
  },
  {
    name: 'art_sheet',
    description: 'Many canvases in one labelled image (project, list or name regex) to review a set for consistency.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' }, canvases: { type: 'array', items: { type: 'string' } }, filter: { type: 'string', description: 'regex on name' },
        exclude: { type: 'string' }, texture_filter: { type: 'string', description: 'regex on meta.texture' }, scale: { type: 'integer' }, cell: { type: 'integer' },
        tile: { type: 'integer' }, apply_tint: { type: 'boolean' }, show_texture: { type: 'boolean' }, columns: { type: 'integer' }, labels: { type: 'boolean' },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
    },
    run: (call, a) => call('sheet', a),
  },
  {
    name: 'art_project',
    description: 'Projects group canvases (sprite set, tileset, pack) with a shared palette and style notes. create {name, palette?, notes?, meta?}; update {name, notes?|append_notes?, meta?}; list; info {name}; delete {name, delete_canvases?}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'list', 'info', 'delete'] }, name: { type: 'string' }, description: { type: 'string' },
        notes: { type: 'string' }, append_notes: { type: 'string' }, palette: { type: 'object', additionalProperties: { type: 'string' } },
        meta: { type: 'object' }, delete_canvases: { type: 'boolean' }, overwrite: { type: 'boolean' },
      },
      required: ['action'],
    },
    run: (call, a) => call(`project_${a.action}`, a),
  },
  {
    name: 'art_read',
    description: 'Exact pixels of a region as text rows + legend (the format art_draw grid accepts). Max 128x128; read small regions.',
    inputSchema: { type: 'object', properties: { canvas: S.canvas, ...region, layer: S.layer, frame: S.frame }, required: ['canvas'] },
    run: (call, a) => call('read', a),
  },
  {
    name: 'art_palette',
    description: 'Palette (canvas, or project:<name> for the shared one). Keys work anywhere a color does; 1-char keys work in grid rows. ramp {base, steps?:5, prefix|keys} = hue-shifted shading ramp dark->light.',
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas, project: { type: 'string' }, action: { type: 'string', enum: ['get', 'set', 'remove', 'clear', 'ramp'] },
        colors: { type: 'object', additionalProperties: { type: 'string' } }, keys: { type: 'array', items: { type: 'string' } },
        base: { type: 'string' }, steps: { type: 'integer' }, prefix: { type: 'string' }, hue_shift: { type: 'number' }, spread: { type: 'number' }, saturation_shift: { type: 'number' },
      },
      required: ['action'],
    },
    run: (call, a) => call('palette', a),
  },
  {
    name: 'art_layer',
    description: 'Layers. add {name, position?: above|below|top|bottom, blend?, opacity?, select?}, remove, select, rename, visibility, opacity, blend, move {index|position}, duplicate, merge_down, flatten {keep_hidden|discard_hidden}, stamp_visible (composite of visible layers -> new top layer).',
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas,
        action: { type: 'string', enum: ['add', 'remove', 'select', 'rename', 'visibility', 'opacity', 'blend', 'move', 'duplicate', 'merge_down', 'flatten', 'stamp_visible'] },
        layer: S.layer, name: { type: 'string' }, index: { type: 'integer' }, position: { type: 'string', enum: ['above', 'below', 'top', 'bottom'] },
        blend: { type: 'string', enum: BLENDS }, opacity: { type: 'number' }, visible: { type: 'boolean' }, select: { type: 'boolean' },
        keep_hidden: { type: 'boolean' }, discard_hidden: { type: 'boolean' }, hide_others: { type: 'boolean' }, keep_visible: { type: 'boolean' },
      },
      required: ['canvas', 'action'],
    },
    run: (call, a) => call('layer', a),
  },
  {
    name: 'art_canvas',
    description: 'Canvas changes: meta (merge; null deletes), delete, duplicate {new_name}, resize {width,height,anchor}, scale {factor|width,height, method: nearest|scale2x (clean pixel-art upscale)}, crop, set_frames {frame_height}, add_frame, normal_map.',
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas, action: { type: 'string', enum: ['meta', 'delete', 'duplicate', 'resize', 'scale', 'crop', 'set_frames', 'add_frame', 'normal_map'] },
        new_name: { type: 'string' }, meta: { type: 'object' }, project: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' },
        anchor: { type: 'string' }, factor: { type: 'number' }, method: { type: 'string', enum: ['nearest', 'scale2x'] }, ...region,
        frame_height: { type: 'integer' }, copy_from: { type: 'integer' }, strength: { type: 'number' }, bevel: { type: 'integer' }, overwrite: { type: 'boolean' },
      },
      required: ['canvas', 'action'],
    },
    run: (call, a) => {
      if (['meta', 'normal_map', 'delete', 'duplicate'].includes(a.action)) return call(a.action, a);
      return call('transform', a);
    },
  },
  {
    name: 'art_animation',
    description: 'Frame strip animation. list; tag {name, from,to|frames, duration|durations|fps, loop?, direction?}; untag; insert {at?, count?, copy_from?}; duplicate {frame, to?}; move {frame, to}; delete {frame|frames}; set_frame_size; filmstrip {animation?} (image of all frames); export {format: gif|spritesheet|frames, animation?, scale?, path?, json?:false (no sidecar)}.',
    inputSchema: {
      type: 'object',
      properties: {
        canvas: S.canvas, action: { type: 'string', enum: ['list', 'tag', 'untag', 'insert', 'duplicate', 'move', 'delete', 'set_frame_size', 'filmstrip', 'export'] },
        name: { type: 'string' }, frames: { type: 'array', items: { type: 'integer' } }, from: { type: 'integer' }, to: { type: 'integer' },
        frame: { type: 'integer' }, at: { type: 'integer' }, count: { type: 'integer' }, copy_from: { type: 'integer' },
        duration: { type: 'integer' }, durations: { type: 'array', items: { type: 'integer' } }, fps: { type: 'number' }, loop: { type: 'boolean' },
        direction: { type: 'string', enum: ['forward', 'reverse', 'pingpong'] }, frame_height: { type: 'integer' }, animation: { type: 'string' },
        onion: { type: 'integer' }, scale: { type: 'integer' }, format: { type: 'string', enum: ['gif', 'spritesheet', 'frames'] }, path: { type: 'string' }, layout: { type: 'string', enum: ['rows', 'strip'] }, json: { type: 'boolean' },
      },
      required: ['canvas', 'action'],
    },
    run: (call, a) => {
      if (a.action === 'filmstrip') return call('filmstrip', a);
      if (a.action === 'export') return call('export_animation', a);
      return call('animation', a);
    },
  },
  {
    name: 'art_rig',
    description: 'Rigs: parts drawn once per view, poses tweened into frames, so a character stays identical across views and animations. Fastest: create {name, frame, template:"humanoid"|"humanoid_hd" (64x96+, 8 directions, IK)|"blob"|"flyer"} (override/add/remove parts, views, poses, presets), draw the cells, animate {preset, view}. Custom: create {name, frame, views?, mirror?, parts:{p:{w,h,pivot,parent?,at?,z?,variants?,views?:{view:{at,z,hidden,pivot}}}}, root?, sampling?, secondary?:{part:{stiffness,damping}}, scale_children?}; info; update; templates; pose {pose, parts:{p:{x,y,rot,sx,sy,variant,hide}}, views?:{view:{p:{..}}}, ik?:{end:{target:[x,y]|{part,at},bend?,rot?}}, from?}; preview; turnaround; animate {preset} or {animation, view, keys:[{pose|parts,t?,ease?,mirror_pairs?}], frames, fps, loop?, plant?, secondary?, plant_feet?, canvas?, only?/hide?}. art_help {topic:"rig"}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'info', 'update', 'pose', 'preview', 'animate', 'turnaround', 'templates'] }, name: { type: 'string' },
        template: { type: 'string', enum: ['humanoid', 'humanoid_hd', 'blob', 'flyer'] }, preset: { type: 'string' }, presets: { type: 'object' }, poses: { type: 'object' }, plant_feet: { type: 'boolean' }, plant: { type: ['boolean', 'array'] }, secondary: { type: ['boolean', 'object'] }, ik: { type: 'object' }, sampling: { type: 'string', enum: ['nearest8', 'rotsprite', 'smooth'] }, scale_children: { type: 'boolean' }, feet: { type: 'array' }, only: { type: 'array', items: { type: 'string' } }, hide: { type: 'array', items: { type: 'string' } },
        frame: { type: 'array', items: { type: 'integer' } }, views: { type: ['array', 'object'] }, mirror: { type: 'object' },
        parts: { type: 'object' }, root: { type: 'array', items: { type: 'number' } }, pairs: { type: 'array' }, project: { type: 'string' }, palette: { type: 'object' },
        pose: { type: 'string' }, from: { type: 'string' }, merge: { type: 'boolean' }, view: { type: 'string' }, scale: { type: 'integer' },
        animation: { type: 'string' }, keys: { type: 'array', items: { type: 'object' } }, frames: { type: 'integer' }, fps: { type: 'number' },
        duration: { type: 'integer' }, loop: { type: 'boolean' }, direction: { type: 'string', enum: ['forward', 'reverse', 'pingpong'] }, canvas: { type: 'string' }, overwrite: { type: 'boolean' },
      },
      required: ['action'],
    },
    run: (call, a) => call(`rig_${a.action}`, a),
  },
  {
    name: 'art_model',
    description: '3D low-poly models textured with pixel art (HD-2D, nearest filter) -> glTF .glb. Units px (32 px = 1 unit). create {name, parts:[{type, ...args, at?:[x,y,z], cell?:[gx,gy,gz] (x grid), turn?:0-3, rotate?:[x,y,z]deg (X,Y,Z about origin or pivot?), scale?, mirror?, array?:{count, step|cell_step, turn?, rotate?, about?}, opacity?|glass?}]}. Kit: floor wall corner pillar column arch vault stairs ledge balustrade roof rubble box (taper|bevel|insets) wedge inset cylinder (r_top/r_bottom, wrap) cone plane shape loft; props: extrude lathe; layout: model (place other models). texture|faces{top,front,..}|side|top|color; world UVs, seamless across pieces. Ruins: broken, holes:<mask>. overlays:[{texture,where:bottom|top|corners|edges}]. ctm {name:<new canvas>, ctm:{base, method:full|compact|horizontal|vertical|random|repeat|overlay, border?}} = connected textures. update {name, parts|add|set:{i:{..}}|remove:[i]}; info; list; delete; preview {name, views?, size?} (game = 38° camera); export {name, path?, instances?, atlas?, up?:"z", normal_maps?}. art_help {topic:"3d"}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'info', 'list', 'delete', 'preview', 'export', 'ctm'] }, name: { type: 'string' },
        parts: { type: 'array', items: MODEL_PART }, add: { type: 'array', items: { type: 'object' } }, set: { type: 'object' }, remove: { type: 'array', items: { type: 'integer' } },
        grid: { type: 'number' }, scale: { type: 'number', description: 'px per unit (32)' }, origin: { type: ['string', 'array'], description: 'auto (part coords)|bottom (props, ships)|center|pivot|[x,y,z]' }, notes: { type: 'string' }, overwrite: { type: 'boolean' },
        overlays: { type: 'array', items: { type: 'object' } }, uv_origin: { type: 'array', items: { type: 'number' } },
        views: { type: 'array', items: { type: ['string', 'object'] }, description: 'game front back side left top iso' }, size: { type: 'integer' }, preview: { type: 'boolean' },
        path: { type: 'string' }, instances: { type: 'boolean' }, atlas: { type: 'boolean' }, up: { type: 'string', enum: ['y', 'z'] }, normal_maps: { type: 'boolean' },
        ctm: { type: 'object', description: 'base|template|overlay, method, border{width,style,color}, connect, from, weights, tile' },
      },
      required: ['action'],
    },
    run: async (call, a) => {
      if (a.action === 'list') return call('model_list', a);
      const { preview, ...rest } = a;
      const r = await call(`model_${a.action}`, rest);
      if (!preview || !['create', 'update'].includes(a.action)) return r;
      const v = await call('model_preview', { name: a.name, views: a.views, size: a.size });
      return { ...r, image: v.image, views: v.views };
    },
  },
  {
    name: 'art_audio',
    description: 'Sound effects, music and audio analysis you read as images + reports (you cannot hear). sfx {recipe|params|layers, seed, variants, vars, fx, reverb, target, loop}; instrument {name, patch, notes}; generate {generator,...}; song {name, text (notation) | song (JSON), intent, genre}; render; analyze {name, view:"mix"} = image + listener report; critique {name, intent, genre}; compare {name, reference}; import {path}; export {name|"x_*", format, stems, layers}; list; info; delete {name|"x_*"}. Details: art_help {topic:"audio"|"music"|"mixing"|"perception"}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sfx', 'instrument', 'generate', 'song', 'render', 'analyze', 'critique', 'compare', 'import', 'export', 'list', 'info', 'delete'] }, name: { type: 'string' },
        recipe: { type: 'string' }, params: { type: 'object' }, layers: { type: ['array', 'object', 'boolean'] }, seed: { type: 'integer' }, variants: { type: 'integer' }, vars: { type: 'object' },
        patch: { type: 'object' }, notes: { type: ['string', 'object'] }, generator: { type: 'string' }, text: { type: 'string' }, song: { type: 'object' },
        intent: { type: 'string' }, genre: { type: 'string' }, view: { type: 'string', enum: ['overview', 'mix'] }, reference: { type: 'string' }, path: { type: 'string' },
        format: { type: 'string', enum: ['wav', 'mp3', 'ogg', 'opus'] }, stems: { type: 'boolean' }, sample_rate: { enum: [44100, 48000] },
        // sfx: fx chain [{type}], reverb {preset, wet}, peak target dBFS, loop true|{length, crossfade}, tail s
        fx: { type: ['array', 'string'] }, reverb: { type: ['object', 'string', 'number', 'boolean'] }, target: { type: 'number' }, loop: { type: ['boolean', 'object'] }, tail: { type: 'number' },
        names: { type: 'array', items: { type: 'string' } },
      },
      required: ['action'],
    },
    run: (call, a) => call(`audio_${a.action}`, a),
  },
  {
    name: 'art_undo',
    description: 'Undo (redo:true = redo) the last N steps; each art_draw call is one step.',
    inputSchema: { type: 'object', properties: { canvas: S.canvas, steps: { type: 'integer' }, redo: { type: 'boolean' } }, required: ['canvas'] },
    run: (call, a) => call('undo', a),
  },
  {
    name: 'art_import',
    description: 'Import a PNG (path or base64) as a new canvas, or as_layer into an existing one.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, base64: { type: 'string' }, canvas: { type: 'string' }, as_layer: { type: 'string' }, project: { type: 'string' }, meta: { type: 'object' }, frame_height: { type: 'integer' }, overwrite: { type: 'boolean' } },
    },
    run: (call, a) => call('import', a),
  },
  {
    name: 'art_export',
    description: 'Export the composited canvas to PNG (relative paths -> workspace/exports). Keep scale 1 for game assets.',
    inputSchema: { type: 'object', properties: { canvas: S.canvas, path: { type: 'string' }, scale: { type: 'integer' }, frame: S.frame, layer: S.layer, tile: { type: 'integer' } }, required: ['canvas'] },
    run: (call, a) => call('export', a),
  },
  {
    name: 'art_minecraft',
    description: 'Minecraft Java packs. vanilla {version, vanilla_action: list|import|mcmeta, filter} = real texture names/sizes (references only); build {project} = write every canvas with meta.texture + zip; init {pack, minecraft:"1.12.2"}; add {pack, canvas, texture}; icon; info; zip. art_help {topic:"minecraft"}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['vanilla', 'build', 'init', 'add', 'icon', 'info', 'zip'] }, pack: { type: 'string' }, project: { type: 'string' },
        minecraft: { type: 'string' }, version: { type: 'string' }, vanilla_action: { type: 'string', enum: ['list', 'import', 'mcmeta'] }, filter: { type: 'string' },
        textures: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' }, canvas: S.canvas, texture: { type: 'string' }, description: { type: 'string' },
        pack_format: { type: 'integer' }, frametime: { type: 'integer' }, interpolate: { type: 'boolean' }, frame_order: { type: 'array' }, out: { type: 'string' },
      },
      required: ['action'],
    },
    run: (call, a) => {
      if (a.action === 'vanilla') return call('mc_vanilla', { ...a, action: a.vanilla_action || 'list' });
      if (a.action === 'build') return call('pack_build', a);
      return call(`pack_${a.action}`, a);
    },
  },
  {
    name: 'art_open_ui',
    description: "Open the live web UI in the user's browser.",
    inputSchema: { type: 'object', properties: { canvas: { type: 'string' } } },
    run: async (call, a, ctx) => {
      const url = ctx.uiUrl() + (a.canvas ? `/#${encodeURIComponent(a.canvas)}` : '');
      openBrowser(url);
      return { opened: url };
    },
  },
];

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log('could not open browser:', e.message);
  }
}

/** Run one MCP tool outside MCP (CLI `agent-art tool`): returns MCP content blocks. */
export async function runTool(name, args, call, backend = { remote: false, uiUrl: () => '', engine: null }) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name} (tools: ${TOOLS.map((t) => t.name).join(', ')})`);
  return toContent(await tool.run(call, args || {}, backend));
}

/** Format a result object into MCP content blocks. */
export function toContent(result) {
  const content = [];
  let image = null;
  if (result && result.image) {
    image = Buffer.isBuffer(result.image) ? result.image.toString('base64') : result.image;
    result = { ...result };
    delete result.image;
  }
  if (result && typeof result.text === 'string' && Object.keys(result).length === 1) {
    content.push({ type: 'text', text: result.text });
  } else if (result && Array.isArray(result.rows) && result.format) {
    const lines = [`region x=${result.x} y=${result.y} w=${result.w} h=${result.h} (format: ${result.format})`];
    if (result.legend) lines.push('legend: ' + Object.entries(result.legend).map(([k, v]) => `${k}=${v}`).join('  '));
    lines.push('rows:', ...result.rows);
    content.push({ type: 'text', text: lines.join('\n') });
  } else {
    content.push({ type: 'text', text: JSON.stringify(result) });
  }
  if (image) content.push({ type: 'image', data: image, mimeType: 'image/png' });
  return content;
}

/** Health check: {ok: true|'mismatch'|false, home?, version?}. */
export async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j.app !== APP_ID) return { ok: false };
    // never proxy to a different Agent Art version: its ops/schemas differ from ours
    if (j.version !== VERSION) return { ok: 'mismatch', version: j.version, home: j.home };
    return { ok: true, version: j.version, home: j.home };
  } catch {
    return { ok: false };
  }
}

/** Same workspace folder (case-insensitive on Windows). */
export function sameHome(a, b) {
  if (!a || !b) return false;
  const n = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return n(a) === n(b);
}

/**
 * Backend that either runs the engine in-process or proxies to an existing server. A session keeps
 * one workspace: when it proxies, the workspace is the server's; if that server dies mid-session the
 * backend re-probes the port range for a server on the same workspace, else hosts one itself on that
 * same workspace (never silently on a different one).
 */
export class Backend {
  constructor({ port, home, open, span = 20 }) {
    this.port = port;
    this.basePort = port;
    this.span = span;
    this.open = !!open;
    this.home = path.resolve(home);
    this.engine = null;
    this.remote = false;
    this.server = null;
  }
  async init() {
    const pr = await probe(this.port);
    if (pr.ok === true) {
      this.remote = true;
      if (pr.home && !sameHome(pr.home, this.home)) {
        log(`note: the server on port ${this.port} uses workspace ${pr.home} (this MCP was configured for ${this.home}); using the server's workspace for this session`);
        this.home = path.resolve(pr.home);
      }
      log(`using existing Agent Art server on port ${this.port} (workspace: ${pr.home || 'unknown'})`);
      return;
    }
    if (pr.ok === 'mismatch') {
      log(`port ${this.port} runs a different Agent Art version; starting our own ${VERSION} server on the next free port (restart the other client to share one UI)`);
      this.port++;
    }
    await this.startLocal();
  }
  async startLocal() {
    this.remote = false;
    if (!this.engine || !sameHome(this.engine.home, this.home)) {
      this.engine?.flush();
      this.engine = new Engine({ home: this.home });
    }
    // the UI always runs with the MCP: if another app holds the port, use the next free one
    const first = this.port;
    for (let port = first; port < first + this.span; port++) {
      try {
        this.server = await startServer(this.engine, { port });
        this.port = port;
        log(`UI running at http://localhost:${port}${port !== first ? ` (port ${first} was taken)` : ''} (workspace: ${this.home})`);
        if (this.open) openBrowser(this.uiUrl());
        return;
      } catch (e) {
        if (e.code === 'EADDRINUSE') {
          const pr = await probe(port);
          if (pr.ok === true && sameHome(pr.home, this.home)) {
            this.port = port;
            this.remote = true;
            log(`using existing Agent Art server on port ${port} (same workspace: ${this.home})`);
            return;
          }
          continue;
        }
        log(`could not start UI: ${e.message} (tools still work)`);
        return;
      }
    }
    log(`could not start UI: ports ${first}-${first + this.span - 1} are taken (tools still work, set AGENT_ART_PORT)`);
  }
  /** The proxied server stopped answering: find one on the same workspace, else host it ourselves. */
  async recover() {
    const lost = this.port;
    log(`the Agent Art server on port ${lost} went away; looking for another server on the same workspace (${this.home}) on ports ${this.basePort}-${this.basePort + this.span - 1}`);
    for (let port = this.basePort; port < this.basePort + this.span; port++) {
      if (port === lost) continue;
      const pr = await probe(port);
      if (pr.ok === true && sameHome(pr.home, this.home)) {
        this.port = port;
        this.remote = true;
        log(`switched to the Agent Art server on port ${port} (same workspace: ${this.home})`);
        return;
      }
    }
    log(`no server on workspace ${this.home} answered; hosting one in this process on that same workspace`);
    this.port = this.basePort;
    await this.startLocal();
  }
  uiUrl() {
    return `http://localhost:${this.port}`;
  }
  async call(op, args, retry = true) {
    if (!this.remote) return packResult(await this.engine.run(op, args, 'agent'));
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${this.port}/api/op`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args, source: 'agent' }),
      });
    } catch (e) {
      if (!retry) throw e;
      await this.recover();
      return this.call(op, args, false);
    }
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j.result;
  }
  close() {
    this.engine?.flush();
    if (!this.server) return Promise.resolve();
    const srv = this.server;
    this.server = null;
    return new Promise((res) => { srv.close(() => res()); srv.closeAllConnections?.(); });
  }
}

export async function runMcp({ port, home, open }) {
  const backend = new Backend({ port, home, open });
  await backend.init();
  const call = (op, args) => backend.call(op, args);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: 'agent-art', version: VERSION },
            instructions: INSTRUCTIONS,
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
          break;
        case 'prompts/list':
          result = { prompts: Object.entries(SKILLS).map(([name, s]) => ({ name, title: s.title, description: `${s.title}. ${s.when}` })) };
          break;
        case 'prompts/get': {
          const name = params?.name;
          result = { description: SKILLS[name]?.title, messages: [{ role: 'user', content: { type: 'text', text: skillText(name) } }] };
          break;
        }
        case 'tools/call': {
          const tool = TOOLS.find((t) => t.name === params?.name);
          if (!tool) {
            result = { content: [{ type: 'text', text: `Unknown tool ${params?.name}` }], isError: true };
            break;
          }
          try {
            const r = await tool.run(call, params.arguments || {}, backend);
            result = { content: toContent(r) };
          } catch (e) {
            result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
          }
          break;
        }
        default:
          if (!isRequest) return; // notifications (initialized, cancelled, ...)
          return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
      if (isRequest) send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }

  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    // serialize: drawing ops must apply in the order they were sent
    for (const m of Array.isArray(msg) ? msg : [msg]) queue = queue.then(() => handle(m));
  });
  rl.on('close', async () => {
    await queue;
    backend.engine?.flush();
    process.exit(0);
  });
}
