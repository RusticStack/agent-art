// HTTP server: web UI, REST/op API, and Server-Sent Events for live updates.
import fs_v from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const VERSION = JSON.parse(fs_v.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { encodeGIF } from './gif.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
export const APP_ID = 'agent-art';

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

export function startServer(engine, { port, host = '127.0.0.1' }) {
  const clients = new Set();
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
          const { op, args, source } = JSON.parse((await readBody(req)) || '{}');
          try {
            const result = await engine.run(op, args || {}, source === 'user' ? 'user' : 'agent');
            return sendJSON(res, 200, { ok: true, result: packResult(result) });
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        }
        return sendJSON(res, 404, { ok: false, error: 'Not found' });
      }

      if (p === '/api/health') return sendJSON(res, 200, { app: APP_ID, version: VERSION, pid: process.pid, home: engine.home, canvases: engine.docs.size });
      if (p === '/api/canvases') return sendJSON(res, 200, engine.run('list'));
      if (p === '/api/log') return sendJSON(res, 200, { log: engine.log.slice(-150) });
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      let m = p.match(/^\/api\/project\/([^/]+)$/);
      if (m) return sendJSON(res, 200, engine.run('project_info', { name: decodeURIComponent(m[1]) }));
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
        const headers = { 'content-type': 'image/png', 'cache-control': 'no-store' };
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
      if (m) return sendJSON(res, 200, engine.run('info', { canvas: decodeURIComponent(m[1]) }));

      // static UI
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return sendJSON(res, 404, { ok: false, error: 'Not found' });
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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
