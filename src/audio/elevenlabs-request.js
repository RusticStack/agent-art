// Child process for src/audio/elevenlabs.js: one HTTP request (job JSON on stdin, API key in AGENT_ART_XI_KEY).
// Prints one JSON line: {status, contentType, bytes?, json?, text?} or {error}. A binary body goes to job.out.
import fs from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  try {
    const job = JSON.parse(input);
    const headers = { 'xi-api-key': process.env.AGENT_ART_XI_KEY || '', accept: '*/*' };
    if (job.body) headers['content-type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), job.timeoutMs || 120000);
    const res = await fetch(job.url, { method: job.method || 'GET', headers, body: job.body ? JSON.stringify(job.body) : undefined, signal: ctl.signal });
    clearTimeout(timer);
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const out = { status: res.status, contentType };
    if (res.ok && job.out && !/json/.test(contentType)) { fs.writeFileSync(job.out, buf); out.bytes = buf.length; }
    else if (/json/.test(contentType)) { try { out.json = JSON.parse(buf.toString('utf8')); } catch { out.text = buf.toString('utf8').slice(0, 500); } }
    else out.text = buf.toString('utf8').slice(0, 500);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: e.name === 'AbortError' ? 'timed out' : e.message })}\n`);
  }
});
