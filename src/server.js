// HTTP server: web UI, REST/op API, and Server-Sent Events for live updates.
import fs_v from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const VERSION = JSON.parse(fs_v.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { encodeGIF } from './gif.js';
import { encodePNG } from './png.js';
import { assetIndex } from './assets.js';
import { assembleGLB, modelDefs, modelThumbnail } from './modelops.js';
import { getAudio } from './audio/ops.js';
import { encodeWAV } from './audio/wav.js';
import { rigLayers, rigDebugRender } from './rigdebug.js';

/**
 * The built web UI (npm run build:ui; the npm package ships it). Its sources in web/ need the
 * bundler (npm packages, and Svelte later), so without a build the server shows NOT_BUILT_PAGE.
 */
export const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui');
export const UI_NOT_BUILT = 'Agent Art web UI not built: run npm run build:ui';
let warnedNotBuilt = false;
const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent Art: web UI not built</title>
</head>
<body style="font: 15px system-ui, sans-serif; margin: 3em; max-width: 44em">
<h1 style="font-size: 1.3em">Web UI not built</h1>
<p>This source checkout has no built web UI. Run <code>npm install</code>, then <code>npm run build:ui</code>, and reload this page. To work on the UI with hot reload, use <code>npm run dev:ui</code>.</p>
<p>The MCP tools and the <code>/api</code> endpoints work without it.</p>
</body>
</html>
`;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mcmeta': 'application/json; charset=utf-8', '.zip': 'application/zip',
};
export const APP_ID = 'agent-art';
/** Header the web UI sends with its op calls: the per-process token embedded in the served page. */
export const UI_TOKEN_HEADER = 'x-agent-art-ui';
const UI_TOKEN_META = 'agent-art-ui-token';
/**
 * Only the web UI may act as the user (source "user" unlocks user-only settings such as
 * art_cleanup config allow_paths). It proves it with the random token this process embeds in the
 * page it serves (a browser page of another origin cannot read it) plus a same-origin Origin
 * header; every other caller (MCP processes, scripts, a body that just says "user") is the agent.
 */
export function opSource(req, claimed, token, port) {
  if (claimed !== 'user') return 'agent';
  const got = String(req.headers[UI_TOKEN_HEADER] || '');
  if (!req.headers.origin || !isLocalOrigin(req.headers.origin, port) || got.length !== token.length) return 'agent';
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token)) ? 'user' : 'agent';
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isLocalOrigin(origin, port) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && Number(u.port || 80) === port;
  } catch {
    return false;
  }
}

/** Serialize an op result for JSON transport (Buffers -> base64). */
export function packResult(result) {
  if (result && Buffer.isBuffer(result.image)) return { ...result, image: result.image.toString('base64') };
  return result;
}

/** Per-workspace UI state (hidden / pinned assets) in <workspace>/ui-state.json. */
function uiStateFile(engine) { return path.join(engine.home, 'ui-state.json'); }
export function readUiState(engine) {
  try { return JSON.parse(fs.readFileSync(uiStateFile(engine), 'utf8')); } catch { return { hidden: [], pinned: [] }; }
}
export function writeUiState(engine, s) {
  const clean = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length <= 200))].slice(0, 5000) : []);
  const out = { hidden: clean(s?.hidden), pinned: clean(s?.pinned), updated: Date.now() };
  fs.writeFileSync(uiStateFile(engine) + '.tmp', JSON.stringify(out));
  fs.renameSync(uiStateFile(engine) + '.tmp', uiStateFile(engine));
  return out;
}

function sendBin(res, type, buf, extra = {}) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(buf);
}

export function startServer(engine, { port, host = '127.0.0.1', uiDir = UI_DIR }) {
  const clients = new Set();
  const uiToken = crypto.randomBytes(24).toString('hex');
  const modelThumbs = new Map(); // model name -> {key, png}
  engine.on('event', (ev) => {
    const msg = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(msg);
  });
  const heartbeat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      if (req.method === 'POST') {
        if (!isLocalOrigin(req.headers.origin, port)) return sendJSON(res, 403, { ok: false, error: 'Cross-origin request refused' });
        if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJSON(res, 415, { ok: false, error: 'Use application/json' });
        if (p === '/api/op') {
          const { op, args, source, trace } = JSON.parse((await readBody(req)) || '{}');
          try {
            // trace (optional): {call, tool} of the MCP tool call this op belongs to (activity timeline)
            const ctx = trace && typeof trace === 'object' && trace.call ? { call: String(trace.call).slice(0, 64), tool: trace.tool ? String(trace.tool).slice(0, 64) : undefined } : null;
            const result = await engine.run(op, args || {}, opSource(req, source, uiToken, port), ctx);
            return sendJSON(res, 200, { ok: true, result: packResult(result) });
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        }
        if (p === '/api/trace') {
          // MCP tool call start / end (sent by MCP processes that proxy to this server)
          const t = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
          if (!t.call) return sendJSON(res, 400, { ok: false, error: 'trace needs "call"' });
          const entry = t.phase === 'end' ? engine.activity.toolEnd(t) : engine.activity.toolStart(t);
          return sendJSON(res, 200, { ok: true, id: entry?.id ?? null });
        }
        if (p === '/api/ui-state') {
          const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)) || '{}');
          const st = writeUiState(engine, body);
          engine.emit('event', { type: 'ui-state', ts: Date.now() });
          return sendJSON(res, 200, { ok: true, state: st });
        }
        return sendJSON(res, 404, { ok: false, error: 'Not found' });
      }

      if (p === '/api/health') return sendJSON(res, 200, { app: APP_ID, version: VERSION, pid: process.pid, home: engine.home, canvases: engine.docs.size });
      if (p === '/api/canvases') return sendJSON(res, 200, engine.peek('list'));
      if (p === '/api/assets') return sendJSON(res, 200, assetIndex(engine));
      if (p === '/api/ui-state') return sendJSON(res, 200, readUiState(engine));
      if (p === '/api/activity') {
        const q = url.searchParams;
        return sendJSON(res, 200, { entries: engine.activity.list({ since: Number(q.get('since') || 0), limit: Math.max(1, Math.min(1500, Number(q.get('limit') || 400))) }), seq: engine.activity.seq });
      }
      if (p === '/api/graph') return sendJSON(res, 200, engine.graph.toJSON());
      if (p === '/api/reviews') return sendJSON(res, 200, engine.peek('review_all'));
      let ri = p.match(/^\/api\/review-image\/(r\d+-\d+\.png)$/);
      if (ri) {
        const file = path.join(engine.home, 'reviews', ri[1]);
        if (!fs.existsSync(file)) return sendJSON(res, 404, { ok: false, error: 'Not found' });
        return sendBin(res, 'image/png', fs.readFileSync(file), { 'cache-control': 'private, max-age=86400' });
      }
      if (p === '/api/graph/node') {
        const id = url.searchParams.get('id') || '';
        let rid;
        try { rid = engine.graph.resolveLoose(id); } catch { rid = id; }
        return sendJSON(res, 200, { ...engine.graph.nodeInfo(rid), text: engine.graph.query({ node: rid, depth: 1 }).text });
      }
      if (p === '/api/log') return sendJSON(res, 200, { log: engine.log.slice(-150) });
      let s = p.match(/^\/api\/snapshot\/(s\d+)(\.png)?$/);
      if (s) {
        const snap = engine.activity.snapshot(s[1]);
        if (!snap) return sendJSON(res, 404, { ok: false, error: 'snapshot expired (the timeline keeps a limited history)' });
        if (!s[2]) { const { png, def, ...meta } = snap; return sendJSON(res, 200, { ...meta, hasDef: !!def }); }
        if (!snap.png && snap.def) {
          // model snapshots render their thumbnail on first view (textures are the current canvases)
          try { engine.activity.setSnapPng(snap, modelThumbnail(engine, snap.def, 160)); } catch (e) { return sendJSON(res, 404, { ok: false, error: e.message }); }
        }
        return sendBin(res, 'image/png', snap.png, { 'cache-control': 'private, max-age=86400' });
      }
      s = p.match(/^\/api\/model\/([^/]+)\/(glb|thumb\.png|uv\.png|info)$/);
      if (s) {
        const name = decodeURIComponent(s[1]);
        let def = modelDefs(engine).get(name);
        const snapId = url.searchParams.get('snap');
        if (snapId) { const sn = engine.activity.snapshot(snapId); if (sn?.def) def = sn.def; }
        if (!def) return sendJSON(res, 404, { ok: false, error: `No model "${name}"` });
        if (s[2] === 'info') return sendJSON(res, 200, engine.peek('model_info', { name }));
        if (s[2] === 'uv.png') {
          // atlas of art_model unwrap: ?layer=texture (what the model uses, default) | base | cohesion | paint | masks | guide | ...
          const cname = (def.unwrap && typeof def.unwrap === 'object' && def.unwrap.canvas) || `${name}_uv`;
          const d = def.unwrap ? engine.docs.get(cname) : null;
          if (!d?.meta?.uv) return sendJSON(res, 404, { ok: false, error: `model "${name}" has no UV atlas (art_model unwrap {name:"${name}"})` });
          const ln = url.searchParams.get('layer') || 'texture';
          const l = ln === 'texture' ? null : d.layers.find((x) => x.name === ln);
          if (ln !== 'texture' && !l) return sendJSON(res, 404, { ok: false, error: `atlas ${cname} has no layer "${ln}" (layers: texture, ${d.layers.map((x) => x.name).join(', ')})` });
          const data = l ? l.data : d.composite({ exclude: ['emissive', 'height', 'metal', 'rough', 'masks', 'guide'] });
          return sendBin(res, 'image/png', encodePNG(d.width, d.height, data));
        }
        if (s[2] === 'thumb.png') {
          const key = `${def.updated || 0}`;
          let t = modelThumbs.get(name);
          if (!t || t.key !== key || snapId) { t = { key, png: modelThumbnail(engine, def, Number(url.searchParams.get('size') || 128)) }; if (!snapId) modelThumbs.set(name, t); }
          return sendBin(res, 'image/png', t.png);
        }
        // materials v2 channel views (UI channel dropdown): ?profile=three (tangents, ORM, extensions,
        // height maps) and &bake=1 (quick lightmap + AO + bent normals on TEXCOORD_1, light parts)
        const prof = url.searchParams.get('profile'), bake = url.searchParams.get('bake') === '1';
        const args = prof === 'three' ? { profile: 'three', ...(bake ? { lightmap: { samples: 12, bounce: 1 }, bake_ao: { samples: 12, bent: true } } : {}) } : {};
        let glb;
        try { ({ glb } = assembleGLB(engine, def, { args })); } catch (e) { if (!prof) throw e; ({ glb } = assembleGLB(engine, def, { args: { profile: 'three' } })); }
        return sendBin(res, 'model/gltf-binary', glb);
      }
      s = p.match(/^\/api\/rig\/([^/]+)\/(layers|debug)$/);
      if (s) {
        // layer stack per frame / one frame as per-part layers (Layers view)
        const q = Object.fromEntries([...url.searchParams].filter(([k]) => ['view', 'canvas', 'tag', 'pose', 'frame'].includes(k)));
        const name = decodeURIComponent(s[1]);
        return sendJSON(res, 200, s[2] === 'layers' ? rigLayers(engine, name, q) : rigDebugRender(engine, name, q));
      }
      s = p.match(/^\/api\/rig\/([^/]+)\/weights\.png$/);
      if (s) {
        // 2D skin: the drawing + lattice | a bone's heat map (Skin view)
        const q = url.searchParams;
        const a = { name: decodeURIComponent(s[1]) };
        for (const k of ['mesh', 'view', 'bone']) if (q.get(k)) a[k] = q.get(k);
        if (q.get('scale')) a.scale = Math.max(1, Math.min(12, Number(q.get('scale')) || 4));
        const r = engine.peek('rig_weights', a);
        if (!r.image) return sendJSON(res, 404, { ok: false, error: 'no mesh drawing to show (pick a mesh / view)' });
        return sendBin(res, 'image/png', r.image);
      }
      s = p.match(/^\/api\/rig\/([^/]+)(\/preview\.png)?$/);
      if (s) {
        const name = decodeURIComponent(s[1]);
        if (!s[2]) return sendJSON(res, 200, engine.peek('rig_info', { name }));
        const q = url.searchParams;
        const a = { name };
        if (q.get('pose')) a.pose = q.get('pose');
        if (q.get('view')) a.view = q.get('view');
        if (q.get('scale')) a.scale = Math.max(1, Math.min(12, Number(q.get('scale'))));
        return sendBin(res, 'image/png', engine.peek('rig_preview', a).image);
      }
      s = p.match(/^\/api\/audio\/([^/]+?)(\.wav|\/analysis)?$/);
      if (s) {
        const name = decodeURIComponent(s[1]);
        if (!s[2]) return sendJSON(res, 200, engine.peek('audio_info', { name }));
        if (s[2] === '.wav') {
          const au = getAudio(engine, name);
          const extra = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${name}.wav"` } : {};
          return sendBin(res, 'audio/wav', encodeWAV(au.chs, { bits: 16 }), extra);
        }
        const r = engine.peek('audio_analyze', { name, view: url.searchParams.get('view') || undefined });
        return sendJSON(res, 200, { name, stats: r.stats, report: r.report, image: Buffer.isBuffer(r.image) ? r.image.toString('base64') : r.image, views: r.views });
      }
      if (p === '/api/export-file') {
        const rel = url.searchParams.get('path') || '';
        const file = path.resolve(engine.exportDir, rel);
        const inside = path.relative(engine.exportDir, file);
        if (!rel || inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJSON(res, 404, { ok: false, error: 'Not found' });
        const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' };
        if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
        res.writeHead(200, headers);
        return fs.createReadStream(file).pipe(res);
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      let m = p.match(/^\/api\/project\/([^/]+)$/);
      if (m) return sendJSON(res, 200, engine.peek('project_info', { name: decodeURIComponent(m[1]) }));
      m = p.match(/^\/api\/canvas\/([^/]+)\/png$/);
      if (m) {
        const d = engine.get(decodeURIComponent(m[1]));
        const q = url.searchParams;
        const opt = { scale: Number(q.get('scale') || 1) };
        if (q.has('layer')) opt.layer = q.get('layer');
        if (q.has('frame')) opt.frame = Number(q.get('frame'));
        if (q.has('tile')) opt.tile = Number(q.get('tile'));
        if (q.has('onion')) opt.onion = Number(q.get('onion'));
        if (q.has('tint')) opt.tint = q.get('tint');
        const png = d.toPNG(opt);
        // ?v=<version> URLs (asset browser thumbnails) are immutable: let the browser cache them
        const headers = { 'content-type': 'image/png', 'cache-control': q.has('v') ? 'private, max-age=3600' : 'no-store' };
        if (q.has('download')) headers['content-disposition'] = `attachment; filename="${d.name}.png"`;
        res.writeHead(200, headers);
        return res.end(png);
      }
      m = p.match(/^\/api\/canvas\/([^/]+)\/anim\.gif$/);
      if (m) {
        const d = engine.get(decodeURIComponent(m[1]));
        const q = url.searchParams;
        const anim = q.get('animation') || undefined;
        const scale = Math.max(1, Math.min(16, Number(q.get('scale') || 4)));
        const { frames, durations } = d.playback(anim);
        const imgs = frames.map((f, i) => ({ data: d.render({ scale, frame: d.frameHeight ? f : undefined }).data, delay: durations[i] }));
        const gif = encodeGIF(d.width * scale, (d.frameHeight || d.height) * scale, imgs);
        const headers = { 'content-type': 'image/gif', 'cache-control': 'no-store' };
        if (q.has('download')) headers['content-disposition'] = `attachment; filename="${d.name}${anim ? '_' + anim : ''}.gif"`;
        res.writeHead(200, headers);
        return res.end(gif);
      }
      m = p.match(/^\/api\/canvas\/([^/]+)$/);
      if (m) return sendJSON(res, 200, engine.peek('info', { canvas: decodeURIComponent(m[1]) }));

      // static UI: the built bundle (npm run build:ui)
      // every page carries this process's UI token (see opSource) and is never cached
      const withToken = (html) => html.replace(/<head>/i, (h) => `${h}\n  <meta name="${UI_TOKEN_META}" content="${uiToken}">`);
      const root = path.resolve(uiDir);
      if (!fs.existsSync(path.join(root, 'index.html'))) {
        if (!warnedNotBuilt) { warnedNotBuilt = true; process.stderr.write(`${UI_NOT_BUILT} (${root} is missing)\n`); }
        if (p !== '/' && p !== '/index.html') return sendJSON(res, 404, { ok: false, error: UI_NOT_BUILT });
        // the page still carries the token, so npm run dev:ui can borrow it from this server
        res.writeHead(503, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return res.end(withToken(NOT_BUILT_PAGE));
      }
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return sendJSON(res, 404, { ok: false, error: 'Not found' });
      }
      if (path.extname(file) === '.html') {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return res.end(withToken(fs.readFileSync(file, 'utf8')));
      }
      // assets/ file names carry a content hash, so they never change
      const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      engine.uiUrl = `http://localhost:${port}`;
      resolve(server);
    });
  });
}
