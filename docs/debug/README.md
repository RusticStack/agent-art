# Debug and usage logging

Agent Art can log every MCP session and tool call to a JSONL file. The point is to see what the tools cost an agent and where agents struggle, so the tool descriptions, replies and defaults can be tuned.

The log covers:
- **Context tokens:** an estimate of what Agent Art adds to the model's context.
- **Time:** how long each call took.
- **Errors**, plus repeated and retried calls.
- **Help:** which `art_help` topics and skills agents had to read.

It is off by default. Nothing is written until you turn it on, and nothing is ever sent anywhere.

## Turn it on

```sh
agent-art mcp --debug              # or AGENT_ART_DEBUG=1
agent-art mcp --debug full         # or AGENT_ART_DEBUG=full: also keeps the full call arguments
```

In an MCP client config:

```json
{ "mcpServers": { "agent-art": { "command": "npx", "args": ["-y", "@rusticstack/agent-art", "mcp", "--debug"] } } }
```

With Claude Code: `claude mcp add agent-art -e AGENT_ART_DEBUG=1 -- npx -y @rusticstack/agent-art mcp`.

Records go to `<workspace>/debug/usage-YYYY-MM-DD.jsonl` (the workspace is `~/.agent-art` unless `--home` or `AGENT_ART_HOME` says otherwise). Set `AGENT_ART_DEBUG_FILE` to write somewhere else. The server prints the path on stderr when it starts.

At the default level, arguments are logged by shape only: the keys, numbers, short names, and `<str N>` or `<array N>` for anything longer. That keeps paths, prompts and pixel data out of the file. `full` keeps everything, for reproducing a bad call.

## Read the report

```sh
agent-art usage                                  # everything in <workspace>/debug
agent-art usage --since 2026-11-09 --tool art_rig
agent-art usage path/to/usage-2026-11-09.jsonl --json
agent-art usage --transcript ~/.claude/projects/<project>/<session>.jsonl
```

The report shows:
- **Per-session overhead:** what the client loads once per session, which is the instructions, every tool definition and the prompt list. It also names the largest tool definitions, which are usually the cheapest place to save tokens.
- **By tool, and top actions:** calls, errors, total and average tokens, split into the arguments the model wrote, the reply text and reply images, with p50 and p95 time.
- **Biggest replies and slowest calls.**
- **Errors:** grouped, with numbers masked so the same mistake counts once.
- **Repeats and retries:** identical calls (polling, or not trusting a reply) and a call that comes within two calls after a failure of the same tool.
- **art_help reads:** guides agents fetch often probably belong in the tool description.
- **Suggestions:** heuristic pointers, such as a high error rate, large replies, image-heavy tools or overhead that outweighs the calls.

`--transcript` adds the real billed token usage from a Claude Code session log: model turns, input, cache write, cache read and output tokens, and the size of each Agent Art tool's arguments and results. The MCP server never sees the model's usage, so this is the ground truth to compare the estimates with.

## Record format

One JSON object per line. Every record has `ts`, `session` and `v` (the Agent Art version).

| `type` | Fields |
| --- | --- |
| `session` | `client` (`clientInfo` from `initialize`), `protocol`, `pid`, `instructions_tokens`, `tools`, `tools_tokens`, `prompts`, `prompts_tokens`, `per_tool` [{name, tokens}] |
| `list` | `method` (`tools/list`, `prompts/list`, `prompts/get`), `chars`, `tokens`, `count` or `name` |
| `call` | `seq`, `tool`, `action` (the `action`/`op`, the `art_help` topic or skill, or the draw ops), `ok`, `ms`, `error`, `args_chars`, `args_tokens`, `reply_chars`, `reply_text_tokens`, `reply_image_tokens`, `images` [{w, h, bytes, tokens}], `tokens` (args + reply), `ops` [{op, ms}] (engine ops the call ran), `hint` (a review note line was added), `repeat` (nth identical call), `retry_of` (seq of the failed call it follows), `args_hash`, `args` |

## How tokens are estimated

- **Text:** words count one token per ~6 letters, digit runs one per 3 digits, and every punctuation mark is one token. That is close to Claude's tokenizer on JSON and English. Treat it as an estimate, good for comparing tools and versions but not exact.
- **Images:** Claude's rule. The image is scaled to fit 1568 px on the long side and about 1.15 MP, then costs w × h / 750 tokens.

## Using it to improve Agent Art

1. Run a real task, or a weak-model benchmark, with `--debug`.
2. In `agent-art usage`, look at the per-session overhead first. Every session pays it, so a long tool description costs more than most replies.
3. Look at the error groups. A repeated error usually means the tool description or the error hint does not say what the agent got wrong.
4. Look at heavy actions. A large default reply can become a summary with `full:true` for the rest, and a large default image can get a smaller `max_size`.
5. Change one thing, rerun the same task, and compare the two reports with `--since` or separate `AGENT_ART_DEBUG_FILE`s.
