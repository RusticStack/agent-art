// Debug / usage logging for the MCP server: one JSONL record per session, list call and tool
// call, so we can see what Agent Art costs an agent (context tokens), where it fails and which
// tools or replies to trim. Off by default. Turn on with `agent-art mcp --debug` or
// AGENT_ART_DEBUG=1 (AGENT_ART_DEBUG=full also keeps the full call arguments).
//
// Token counts are estimates of what Agent Art adds to the model's context (tool definitions,
// instructions, arguments the model wrote, replies it reads). The server never sees the model's
// real usage; `agent-art usage --transcript <claude-code.jsonl>` reads that from a client log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Debug level from a CLI flag and the environment: null (off) | 'on' | 'full'. */
export function debugLevel(flagValue, env = process.env) {
  const v = flagValue === true ? 'on' : (flagValue ?? env.AGENT_ART_DEBUG ?? '');
  const s = String(v).trim().toLowerCase();
  if (!s || /^(0|false|no|off)$/.test(s)) return null;
  return s === 'full' ? 'full' : 'on';
}

/** Where the log goes: AGENT_ART_DEBUG_FILE, else <home>/debug/usage-YYYY-MM-DD.jsonl. */
export function usageFile(home, env = process.env, now = new Date()) {
  if (env.AGENT_ART_DEBUG_FILE) return path.resolve(String(env.AGENT_ART_DEBUG_FILE));
  return path.join(home, 'debug', `usage-${now.toISOString().slice(0, 10)}.jsonl`);
}

/**
 * Rough token count for text an LLM reads, dependency free. Fitted against Anthropic's public
 * tokenizer on Agent Art's own tool schemas, descriptions, help topics, skills, README and replies:
 * ~6% mean error (worst ~20% on tiny strings). A word (with its leading space) is one token per
 * 7 letters, digit runs one per 3, a run of punctuation one per 3 marks, each newline one.
 * Newer Claude tokenizers count somewhat differently: compare tools and versions with it, don't bill.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let n = 0;
  for (const m of String(text).matchAll(/ ?[A-Za-z]+| ?\d+|[^\sA-Za-z\d]+|\s+/g)) {
    const t = m[0];
    if (/^ ?[A-Za-z]/.test(t)) n += Math.ceil(t.trim().length / 7);
    else if (/^ ?\d/.test(t)) n += Math.ceil(t.trim().length / 3);
    else if (/^\s+$/.test(t)) n += t.includes('\n') ? t.split('\n').length - 1 : (t.length > 1 ? 1 : 0);
    else n += Math.ceil(t.length / 3);
  }
  return n;
}

/** Width and height of a base64 PNG (from the IHDR chunk), or null. */
export function pngSize(b64) {
  try {
    const head = Buffer.from(String(b64).slice(0, 44), 'base64');
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch { return null; }
}

/** Claude's image cost: the image is scaled to fit 1568 px on the long side and ~1.15 MP, then w*h/750. */
export function imageTokens(w, h) {
  if (!w || !h) return 0;
  let s = Math.min(1, 1568 / Math.max(w, h));
  s = Math.min(s, Math.sqrt(1.15e6 / (w * h)));
  return Math.ceil((w * s) * (h * s) / 750);
}

/** Measure MCP content blocks: text chars and tokens, images with size and tokens. */
export function measureContent(content = []) {
  let chars = 0, text = 0, img = 0;
  const images = [];
  for (const c of content) {
    if (c?.type === 'text') { chars += c.text.length; text += estimateTokens(c.text); }
    else if (c?.type === 'image') {
      const sz = pngSize(c.data) || { w: 0, h: 0 };
      const t = imageTokens(sz.w, sz.h);
      img += t;
      images.push({ w: sz.w, h: sz.h, bytes: Math.floor(String(c.data).length * 3 / 4), tokens: t });
    }
  }
  return { chars, text_tokens: text, image_tokens: img, images, tokens: text + img };
}

/** What sub-command a tool call ran (action, op, topic, skill), for grouping. */
export function callAction(tool, a = {}) {
  if (tool === 'art_help') return a.skill ? `skill:${a.skill}` : a.op ? `op:${a.op}` : a.topic ? `topic:${a.topic}` : 'index';
  if (tool === 'art_draw' && Array.isArray(a.commands)) return [...new Set(a.commands.map((c) => c?.op))].slice(0, 4).join('+') || null;
  return a.action ?? a.op ?? null;
}

const stableHash = (v) => crypto.createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);

/** Cost of what a client loads once per session: instructions, tool list, prompt list. */
export function sessionOverhead({ instructions = '', tools = [], prompts = [] }) {
  const per = tools.map((t) => ({ name: t.name, tokens: estimateTokens(JSON.stringify(t)) })).sort((a, b) => b.tokens - a.tokens);
  const toolTokens = per.reduce((s, t) => s + t.tokens, 0);
  return {
    instructions_tokens: estimateTokens(instructions),
    tools: tools.length,
    tools_tokens: toolTokens,
    prompts: prompts.length,
    prompts_tokens: estimateTokens(JSON.stringify(prompts)),
    per_tool: per,
  };
}

/** Appends usage records to a JSONL file; never throws into the server. */
export class UsageLog {
  constructor({ file, level = 'on', version = '', write, session } = {}) {
    this.file = file;
    this.level = level;
    this.version = version;
    // one id per server process; CLI calls (one process each) share AGENT_ART_DEBUG_SESSION
    this.session = session || `s${Date.now().toString(36)}${process.pid.toString(36)}`;
    this.seq = 0;
    this.seen = new Map(); // tool+args hash -> count (repeat detection)
    this.lastError = null; // {tool, seq} of the last failed call
    this.write = write || ((line) => { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, line); });
  }
  record(ev) {
    try {
      this.write(JSON.stringify({ ts: new Date().toISOString(), session: this.session, v: this.version, ...ev }) + '\n');
    } catch { /* logging must never break a tool call */ }
  }
  /** Session start: client info and the fixed per-session overhead. */
  start({ client, protocol, instructions, tools, prompts }) {
    const o = sessionOverhead({ instructions, tools, prompts });
    this.record({ type: 'session', client: client || null, protocol: protocol || null, pid: process.pid, ...o });
  }
  /** tools/list, prompts/list, prompts/get, resources: payload size. */
  list(method, payload, extra = {}) {
    const s = JSON.stringify(payload ?? null);
    this.record({ type: 'list', method, chars: s.length, tokens: estimateTokens(s), ...extra });
  }
  /** One tool call. args = what the model sent; content = the reply blocks; ops = engine ops run. */
  call({ tool, args = {}, content = [], ms = 0, ok = true, error = null, ops = [], hint = false }) {
    const seq = ++this.seq;
    const argText = JSON.stringify(args);
    const key = stableHash([tool, args]);
    const repeat = (this.seen.get(key) || 0) + 1;
    this.seen.set(key, repeat);
    const retryOf = !ok ? null : (this.lastError && this.lastError.tool === tool && seq - this.lastError.seq <= 2 ? this.lastError.seq : null);
    if (!ok) this.lastError = { tool, seq };
    else if (retryOf) this.lastError = null;
    const m = measureContent(content);
    const rec = {
      type: 'call', seq, tool, action: callAction(tool, args),
      ok, ms: Math.round(ms), error: error ? String(error).slice(0, 300) : undefined,
      args_chars: argText.length, args_tokens: estimateTokens(argText),
      reply_chars: m.chars, reply_text_tokens: m.text_tokens, reply_image_tokens: m.image_tokens,
      images: m.images.length ? m.images : undefined,
      tokens: estimateTokens(argText) + m.tokens,
      ops: ops.length ? ops : undefined,
      hint: hint || undefined,
      repeat: repeat > 1 ? repeat : undefined,
      retry_of: retryOf ?? undefined,
      args_hash: key,
    };
    rec.args = this.level === 'full' ? args : argKeys(args);
    this.record(rec);
    return rec;
  }
}

/** Argument shape without the content: key -> type/size (the default log level). */
function argKeys(a) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (v === null || typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length <= 40 && !/[\\/]/.test(v) ? v : `<str ${v.length}>`;
    else if (Array.isArray(v)) out[k] = `<array ${v.length}>`;
    else out[k] = `<object ${Object.keys(v).length}>`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reports

/** Read usage records from files and directories (JSONL; bad lines are skipped). */
export function readUsage(paths) {
  const files = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) { if (f.endsWith('.jsonl')) files.push(path.join(p, f)); }
    else files.push(p);
  }
  const recs = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return recs;
}

const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sum = (xs) => xs.reduce((s, x) => s + (x || 0), 0);

/** Aggregate records into a report object. filter: {since?: ISO date, session?, tool?}. */
export function summarizeUsage(recs, filter = {}) {
  let rs = recs;
  if (filter.since) rs = rs.filter((r) => String(r.ts) >= filter.since);
  if (filter.session) rs = rs.filter((r) => r.session === filter.session);
  const sessions = rs.filter((r) => r.type === 'session');
  let calls = rs.filter((r) => r.type === 'call');
  if (filter.tool) calls = calls.filter((r) => r.tool === filter.tool);
  const group = (key) => {
    const m = new Map();
    for (const c of calls) { const k = key(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
    return [...m].map(([k, cs]) => ({
      key: k, calls: cs.length, errors: cs.filter((c) => !c.ok).length,
      tokens: sum(cs.map((c) => c.tokens)), avg_tokens: Math.round(sum(cs.map((c) => c.tokens)) / cs.length),
      avg_args: Math.round(sum(cs.map((c) => c.args_tokens)) / cs.length),
      avg_reply: Math.round(sum(cs.map((c) => (c.reply_text_tokens || 0) + (c.reply_image_tokens || 0))) / cs.length),
      image_tokens: sum(cs.map((c) => c.reply_image_tokens)),
      p50_ms: pct(cs.map((c) => c.ms), 0.5), p95_ms: pct(cs.map((c) => c.ms), 0.95),
    })).sort((a, b) => b.tokens - a.tokens);
  };
  const errs = new Map();
  for (const c of calls) if (!c.ok) {
    const k = `${c.tool}${c.action ? ' ' + c.action : ''}: ${String(c.error || '').replace(/\d+/g, 'N').slice(0, 120)}`;
    errs.set(k, (errs.get(k) || 0) + 1);
  }
  const help = calls.filter((c) => c.tool === 'art_help');
  const overhead = sessions.length ? sessions[sessions.length - 1] : null;
  const totalCallTokens = sum(calls.map((c) => c.tokens));
  const rep = {
    sessions: new Set(rs.map((r) => r.session)).size,
    clients: [...new Set(sessions.map((s) => s.client?.name ? `${s.client.name} ${s.client.version || ''}`.trim() : 'unknown'))],
    calls: calls.length,
    errors: calls.filter((c) => !c.ok).length,
    tokens: totalCallTokens,
    overhead: overhead ? { instructions: overhead.instructions_tokens, tools: overhead.tools_tokens, prompts: overhead.prompts_tokens, count: overhead.tools, top: (overhead.per_tool || []).slice(0, 6) } : null,
    by_tool: group((c) => c.tool),
    by_action: group((c) => `${c.tool}${c.action ? ' ' + c.action : ''}`).slice(0, 15),
    biggest: [...calls].sort((a, b) => b.tokens - a.tokens).slice(0, 8).map((c) => ({ ts: c.ts, tool: c.tool, action: c.action, tokens: c.tokens, reply_image_tokens: c.reply_image_tokens, images: c.images })),
    slowest: [...calls].sort((a, b) => b.ms - a.ms).slice(0, 5).map((c) => ({ ts: c.ts, tool: c.tool, action: c.action, ms: c.ms })),
    errors_top: [...errs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ error: k, count: n })),
    ...repeatsAndRetries(calls),
    help_topics: Object.entries(help.reduce((m, c) => { m[c.action] = (m[c.action] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]),
  };
  rep.suggestions = suggestions(rep);
  return rep;
}

/**
 * Identical calls (same tool + arguments) and retries (a successful call of the tool that failed
 * within the previous two calls), per session in log order: CLI sessions span many processes.
 */
function repeatsAndRetries(calls) {
  let repeats = 0, retries = 0;
  const bySession = new Map();
  for (const c of calls) { if (!bySession.has(c.session)) bySession.set(c.session, []); bySession.get(c.session).push(c); }
  for (const cs of bySession.values()) {
    const seen = new Set();
    cs.forEach((c, i) => {
      const key = c.args_hash || `${c.tool}:${JSON.stringify(c.args)}`;
      if (seen.has(key)) repeats++; else seen.add(key);
      if (c.ok && cs.slice(Math.max(0, i - 2), i).some((p) => !p.ok && p.tool === c.tool)) retries++;
    });
  }
  return { repeats, retries };
}

/** Heuristic pointers at what to optimise. */
function suggestions(rep) {
  const out = [];
  for (const t of rep.by_tool) {
    if (t.calls >= 5 && t.errors / t.calls > 0.2) out.push(`${t.key}: ${Math.round(100 * t.errors / t.calls)}% of calls fail; look at errors_top and make the description or the error hint say what the agent got wrong.`);
    if (t.calls >= 3 && t.avg_reply > 1500) out.push(`${t.key}: replies average ~${t.avg_reply} tokens; a compact default (summary + full:true) would save context.`);
    if (t.image_tokens > 0.5 * t.tokens && t.image_tokens > 5000) out.push(`${t.key}: images are ${Math.round(100 * t.image_tokens / t.tokens)}% of its cost; a smaller default max_size / zoom would help.`);
  }
  for (const [topic, n] of rep.help_topics) if (n >= 3) out.push(`art_help ${topic} was read ${n} times; if agents need it that often, move its key line into the tool description or the instructions.`);
  if (rep.calls && rep.repeats / rep.calls > 0.1) out.push(`${rep.repeats} identical repeated calls (${Math.round(100 * rep.repeats / rep.calls)}%); agents may be polling or not trusting a reply.`);
  if (rep.overhead && rep.calls && rep.overhead.tools + rep.overhead.instructions > rep.tokens / Math.max(1, rep.sessions)) out.push(`The fixed tool list + instructions (~${rep.overhead.tools + rep.overhead.instructions} tokens per session) costs more than the calls in an average session; trim the largest tool descriptions first.`);
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/** A readable text report. */
export function formatUsage(rep) {
  const L = [];
  L.push(`Agent Art usage: ${rep.sessions} session(s), ${rep.calls} tool calls, ${rep.errors} errors, ~${rep.tokens} tokens in calls (estimates)`);
  if (rep.clients.length) L.push(`clients: ${rep.clients.join(', ')}`);
  if (rep.overhead) {
    L.push('', `Per-session overhead: instructions ~${rep.overhead.instructions}, ${rep.overhead.count} tool definitions ~${rep.overhead.tools}, prompts list ~${rep.overhead.prompts} tokens`);
    L.push('  largest tool definitions: ' + rep.overhead.top.map((t) => `${t.name} ${t.tokens}`).join(', '));
  }
  const table = (title, rows) => {
    if (!rows.length) return;
    L.push('', title, `  ${pad('', 34)}${lpad('calls', 6)}${lpad('err', 5)}${lpad('tokens', 9)}${lpad('avg', 7)}${lpad('args', 6)}${lpad('reply', 7)}${lpad('img', 8)}${lpad('p50ms', 7)}${lpad('p95ms', 7)}`);
    for (const r of rows) L.push(`  ${pad(String(r.key).slice(0, 33), 34)}${lpad(r.calls, 6)}${lpad(r.errors, 5)}${lpad(r.tokens, 9)}${lpad(r.avg_tokens, 7)}${lpad(r.avg_args, 6)}${lpad(r.avg_reply, 7)}${lpad(r.image_tokens, 8)}${lpad(r.p50_ms, 7)}${lpad(r.p95_ms, 7)}`);
  };
  table('By tool', rep.by_tool);
  table('Top actions by tokens', rep.by_action);
  if (rep.biggest.length) { L.push('', 'Biggest replies'); for (const b of rep.biggest) L.push(`  ${b.tokens} tok  ${b.tool}${b.action ? ' ' + b.action : ''}${b.images ? `  (images ${b.images.map((i) => `${i.w}x${i.h}`).join(', ')}: ${b.reply_image_tokens} tok)` : ''}  ${b.ts}`); }
  if (rep.slowest.length) { L.push('', 'Slowest calls'); for (const s of rep.slowest) L.push(`  ${s.ms} ms  ${s.tool}${s.action ? ' ' + s.action : ''}  ${s.ts}`); }
  if (rep.errors_top.length) { L.push('', 'Errors'); for (const e of rep.errors_top) L.push(`  ${lpad(e.count, 4)}x  ${e.error}`); }
  if (rep.help_topics.length) L.push('', 'art_help reads: ' + rep.help_topics.map(([k, n]) => `${k} ${n}`).join(', '));
  L.push('', `Repeated identical calls: ${rep.repeats}; retries right after an error: ${rep.retries}`);
  if (rep.suggestions.length) { L.push('', 'Suggestions'); for (const s of rep.suggestions) L.push(`  - ${s}`); }
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Client transcripts (real token usage)

/**
 * Real usage from a Claude Code session transcript (JSONL): the model's billed tokens per turn and
 * the Agent Art tool calls in it. Lines that are not in that shape are ignored.
 */
export function transcriptUsage(text, prefix = 'mcp__agent-art__') {
  const u = { turns: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0, by_tool: {}, result_chars: 0 };
  const ids = new Map();
  const seenMsg = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const msg = j.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    if (j.type === 'assistant' && msg.usage) {
      // a streamed message can be logged once per content block with the same id and usage
      if (!msg.id || !seenMsg.has(msg.id)) {
        if (msg.id) seenMsg.add(msg.id);
        u.turns++;
        u.input += msg.usage.input_tokens || 0;
        u.cache_write += msg.usage.cache_creation_input_tokens || 0;
        u.cache_read += msg.usage.cache_read_input_tokens || 0;
        u.output += msg.usage.output_tokens || 0;
      }
    }
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && String(b.name).startsWith(prefix)) {
        const name = b.name.slice(prefix.length);
        u.calls++;
        const t = (u.by_tool[name] ||= { calls: 0, input_chars: 0, result_chars: 0, errors: 0 });
        t.calls++;
        t.input_chars += JSON.stringify(b.input ?? {}).length;
        ids.set(b.id, name);
      } else if (b?.type === 'tool_result' && ids.has(b.tool_use_id)) {
        const t = u.by_tool[ids.get(b.tool_use_id)];
        const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const n = sum(parts.map((p) => (p.type === 'text' ? p.text.length : 0)));
        t.result_chars += n;
        u.result_chars += n;
        if (b.is_error) t.errors++;
      }
    }
  }
  return u;
}

export function formatTranscript(u) {
  const L = [`Client transcript: ${u.turns} model turns; input ${u.input}, cache write ${u.cache_write}, cache read ${u.cache_read}, output ${u.output} tokens (billed, from the client)`];
  L.push(`Agent Art calls: ${u.calls}, tool result text ${u.result_chars} chars`);
  for (const [k, t] of Object.entries(u.by_tool).sort((a, b) => b[1].result_chars - a[1].result_chars)) L.push(`  ${pad(k, 20)} ${lpad(t.calls, 5)} calls  args ${lpad(t.input_chars, 8)} chars  results ${lpad(t.result_chars, 9)} chars  ${t.errors ? t.errors + ' errors' : ''}`);
  return L.join('\n');
}
