// source "user" over HTTP: only the web UI (the per-process token embedded in the page it is
// served + a same-origin Origin header) may act as the user; a POST body that just says
// source:"user" (an agent script, no Origin header) is the agent and cannot change allow_paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { startServer, UI_TOKEN_HEADER } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-art-uitoken-'));
const close = (srv) => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); });

test('ui token: source "user" needs the token of the served page and a same-origin request', async () => {
  const e = new Engine({ home: tmp() });
  const allow = tmp();
  const port = 7940 + Math.floor(Math.random() * 40);
  const srv = await startServer(e, { port });
  const op = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/op`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
  const set = { op: 'cleanup_config', args: { allow_paths: [allow] }, source: 'user' };
  const origin = `http://localhost:${port}`;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const token = html.match(/<meta name="agent-art-ui-token" content="([0-9a-f]+)">/)?.[1];
    assert.ok(token && token.length >= 32, 'the page carries the UI token');
    assert.match(html, /<title>Agent Art<\/title>/, 'the rest of the page is unchanged');
    // claimed user without proof -> agent
    for (const headers of [{}, { origin }, { [UI_TOKEN_HEADER]: token }, { origin, [UI_TOKEN_HEADER]: 'f'.repeat(token.length) }, { origin: 'http://localhost:1', [UI_TOKEN_HEADER]: token }]) {
      const r = await op(set, headers);
      assert.equal(r.ok, false, `refused with ${JSON.stringify(Object.keys(headers))}`);
      assert.match(r.error, /set by the user|Cross-origin request refused/);
    }
    assert.equal(e.run('cleanup_config', {}).allow_paths?.length ?? 0, 0);
    // the web UI (token + same origin) is the user
    const ok = await op(set, { origin, [UI_TOKEN_HEADER]: token });
    assert.equal(ok.ok, true, ok.error);
    assert.ok(fs.readFileSync(path.join(e.home, 'config.json'), 'utf8').includes(path.basename(allow)));
    // ordinary agent ops still work without any token
    assert.equal((await op({ op: 'create', args: { name: 'hat', width: 8 }, source: 'agent' })).ok, true);
    // a new server process has a new token
    const srv2 = await startServer(new Engine({ home: tmp() }), { port: port + 50 });
    try {
      const t2 = (await (await fetch(`http://127.0.0.1:${port + 50}/`)).text()).match(/agent-art-ui-token" content="([0-9a-f]+)"/)[1];
      assert.notEqual(t2, token);
    } finally { await close(srv2); }
  } finally { await close(srv); }
});
