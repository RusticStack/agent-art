// A stand-in for the ElevenLabs API (test/voice.test.js). Accepts the key "test-key"; prints its port; appends
// each request as a JSON line to argv[2]. /v2/voices lists two voices; text-to-speech returns a 24 kHz WAV tone.
import http from 'node:http';
import fs from 'node:fs';
import { encodeWAV } from '../../src/audio/wav.js';

const log = process.argv[2];
const VOICES = [
  { voice_id: 'AAAAAAAAAAAAAAAAAAA1', name: 'Rachel', category: 'premade', labels: { accent: 'american', gender: 'female' } },
  { voice_id: 'BBBBBBBBBBBBBBBBBBB2', name: 'Grim Guard', category: 'cloned', labels: { description: 'deep' } },
];
const tone = (sr) => { const n = Math.round(sr * 0.8); const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 180 * i) / sr) * Math.min(1, i / 400, (n - i) / 400); return encodeWAV([x], { bits: 16, sr, dither: false }); };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    fs.appendFileSync(log, `${JSON.stringify({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), key_ok: req.headers['xi-api-key'] === 'test-key', body: body ? JSON.parse(body) : null })}\n`);
    if (req.headers['xi-api-key'] !== 'test-key') return json(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    if (req.method === 'GET' && u.pathname === '/v2/voices') {
      const q = (u.searchParams.get('search') || '').toLowerCase();
      return json(res, 200, { voices: VOICES.filter((v) => !q || v.name.toLowerCase().includes(q) || Object.values(v.labels).some((l) => l.includes(q))), has_more: false });
    }
    const m = /^\/v1\/text-to-speech\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'POST' && m) {
      if (!VOICES.some((v) => v.voice_id === m[1])) return json(res, 404, { detail: { status: 'voice_not_found', message: 'A voice with that ID was not found.' } });
      const fmt = u.searchParams.get('output_format') || 'mp3_44100_128';
      if (fmt === 'wav_44100') return json(res, 403, { detail: { status: 'output_format_not_allowed', message: 'This output format requires a Pro tier subscription.' } });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(tone(Number(fmt.split('_')[1])));
    }
    json(res, 404, { detail: 'Not Found' });
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
