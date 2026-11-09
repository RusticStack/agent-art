// ElevenLabs text-to-speech for voice acting. The API key is read from the environment (ELEVENLABS_API_KEY,
// a system / user variable) or from a .env file in the project (the server's working directory) or the
// workspace; never from tool arguments, so it is not in the MCP config, the usage log or any reply.
// Requests run in a short child process (spawnSync) because engine ops are synchronous; the key reaches
// that process through its environment only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KEY_VARS = ['ELEVENLABS_API_KEY', 'XI_API_KEY'];
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
/** Output formats we ask for: WAV at 24 kHz on every plan; 44.1 / 48 kHz need an ElevenLabs Pro plan. */
export const VOICE_RATES = { 16000: 'wav_16000', 22050: 'wav_22050', 24000: 'wav_24000', 44100: 'wav_44100', 48000: 'wav_48000' };
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'elevenlabs-request.js');

/** Value of KEY in a .env file (KEY=value, optional quotes / export, # comments); null when absent. */
export function readDotEnv(file, keys = KEY_VARS) {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !keys.includes(m[1])) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v) return v;
  }
  return null;
}

/** {key, from} or null. Order: environment, <cwd>/.env, <home>/.env. `from` names the place, never the key. */
export function findApiKey({ cwd = process.cwd(), home = null, env = process.env } = {}) {
  for (const k of KEY_VARS) if (env[k]) return { key: env[k], from: `environment variable ${k}` };
  for (const dir of [cwd, home].filter(Boolean)) {
    const f = path.join(dir, '.env'), key = readDotEnv(f);
    if (key) return { key, from: f };
  }
  return null;
}

export function missingKeyError({ cwd, home }) {
  return new Error(`ElevenLabs API key not found. Set ELEVENLABS_API_KEY as a system / user environment variable, or put ELEVENLABS_API_KEY=... in a .env file in the project (${path.join(cwd, '.env')})${home ? ` or the workspace (${path.join(home, '.env')})` : ''}. A .env is read on each call; a new environment variable needs an MCP server restart. Keep the key out of the MCP config and out of git (add .env to .gitignore).`);
}

const baseUrl = () => (process.env.AGENT_ART_ELEVENLABS_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');

/** One HTTP request in a child process. out: file for a binary body. Returns {status, json?, bytes?}. */
export function request({ key, method = 'GET', pathname, query = {}, body = null, out = null, timeoutMs = 120000 }) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  const job = { url: `${baseUrl()}${pathname}${qs ? `?${qs}` : ''}`, method, body, out, timeoutMs };
  const r = spawnSync(process.execPath, [HELPER], { input: JSON.stringify(job), env: { ...process.env, AGENT_ART_XI_KEY: key }, encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`ElevenLabs request failed: ${r.error.code === 'ETIMEDOUT' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : r.error.message}`);
  let res;
  try { res = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { throw new Error(`ElevenLabs request failed: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`); }
  if (res.error) throw new Error(`ElevenLabs request failed: ${res.error}`);
  if (res.status >= 400) {
    const d = res.json?.detail, msg = typeof d === 'string' ? d : d?.message || (Array.isArray(d) ? d.map((x) => x.msg).join('; ') : JSON.stringify(d ?? res.text ?? '').slice(0, 300));
    const hint = res.status === 401 ? ' (check the API key)' : res.status === 429 ? ' (rate limit or quota: wait, or check your ElevenLabs plan)' : res.status === 403 && /pro|tier|plan|subscri/i.test(msg) ? ' (this output format or model needs a higher ElevenLabs plan: try sample_rate 24000)' : '';
    throw new Error(`ElevenLabs ${res.status}: ${msg}${hint}`);
  }
  return res;
}

/** Voices visible to the key: [{voice_id, name, category, labels}] (search matches name / labels). */
export function listVoices(key, { search = null, category = null, limit = 50 } = {}) {
  const res = request({ key, pathname: '/v2/voices', query: { search, category, page_size: Math.min(100, Math.max(1, limit)) } });
  return (res.json?.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels || {} }));
}

/** A voice id from an id or a (case-insensitive) name. */
export function resolveVoice(key, voice) {
  if (!voice || typeof voice !== 'string') throw new Error('voice needs "voice": a voice name ("Rachel") or voice_id (art_audio {action:"voices"} lists them)');
  if (/^[A-Za-z0-9]{20}$/.test(voice)) return { voice_id: voice, name: null };
  const found = listVoices(key, { search: voice, limit: 100 });
  const lc = voice.toLowerCase();
  const hit = found.find((v) => v.name.toLowerCase() === lc) || found.find((v) => v.name.toLowerCase().startsWith(lc)) || found[0];
  if (!hit) {
    const all = listVoices(key, { limit: 30 }).map((v) => v.name);
    throw new Error(`no ElevenLabs voice matches "${voice}". Voices: ${all.join(', ') || '(none on this account)'}`);
  }
  return { voice_id: hit.voice_id, name: hit.name };
}

/** Text to speech into `out` (.wav). Returns {voice_id, voice_name, model, format, bytes}. */
export function synthesize(key, { text, voice, model = DEFAULT_MODEL, sampleRate = 24000, settings = {}, seed, language, previous_text, next_text, out }) {
  if (!text || typeof text !== 'string') throw new Error('voice needs "text" (the line to speak)');
  const format = VOICE_RATES[sampleRate];
  if (!format) throw new Error(`sample_rate for voice must be one of ${Object.keys(VOICE_RATES).join(', ')} (44100 / 48000 need an ElevenLabs Pro plan)`);
  const v = resolveVoice(key, voice);
  const vs = Object.fromEntries(Object.entries({ stability: settings.stability, similarity_boost: settings.similarity, style: settings.style, speed: settings.speed, use_speaker_boost: settings.speaker_boost }).filter(([, x]) => x !== undefined && x !== null));
  const body = { text, model_id: model, ...(Object.keys(vs).length ? { voice_settings: vs } : {}), ...(seed !== undefined ? { seed } : {}), ...(language ? { language_code: language } : {}), ...(previous_text ? { previous_text } : {}), ...(next_text ? { next_text } : {}) };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const res = request({ key, method: 'POST', pathname: `/v1/text-to-speech/${encodeURIComponent(v.voice_id)}`, query: { output_format: format }, body, out });
  if (!fs.existsSync(out) || fs.statSync(out).size < 64) throw new Error('ElevenLabs returned no audio');
  if (fs.readFileSync(out).toString('ascii', 0, 4) !== 'RIFF') { fs.rmSync(out, { force: true }); throw new Error(`ElevenLabs returned ${res.contentType || 'something'} instead of WAV audio`); }
  return { voice_id: v.voice_id, voice_name: v.name, model, format, bytes: res.bytes };
}
