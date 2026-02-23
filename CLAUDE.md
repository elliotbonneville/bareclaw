# BAREclaw

One daemon, many mouths, one brain. A thin multiplexer that routes HTTP and Telegram into persistent `claude -p` processes over stream-JSON stdio.

## Setup

```bash
npm install
cp .env.example .env   # edit if needed — works with zero config for localhost
npm run dev             # runs via tsx with .env file watching
```

Test it:

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "hello"}'
```

First message per channel is slow (~15-30s, spawning claude). Subsequent messages reuse the warm process (3-5s).

## Key config

All env vars — see `.env.example` for the full list. The important ones:

- `BARECLAW_CWD` — working directory for claude processes. Determines which CLAUDE.md and project context Claude sees. Set to this repo's path for self-modification.
- `BARECLAW_HTTP_TOKEN` — Bearer token for HTTP auth. **Set this** if exposing beyond localhost.
- `BARECLAW_TELEGRAM_TOKEN` + `BARECLAW_ALLOWED_USERS` — Telegram bot token and required user ID allowlist. Get the token from @BotFather, your user ID from @userinfobot.
- `BARECLAW_ALLOWED_TOOLS` — comma-separated tools auto-approved for claude. Default: `Read,Glob,Grep,Bash,Write,Edit`
- `BARECLAW_MAX_TURNS` — max agentic turns per message (default 25). Prevents runaway loops.

## Architecture

```
src/
  index.ts                 # Entry point: Express server, Telegram bot, signals, self-restart
  config.ts                # Env var loading with defaults and type conversion
  core/
    types.ts               # Protocol types (ClaudeInput, ClaudeResultEvent, etc.)
    process-manager.ts     # THE core — spawns/manages persistent claude processes, one per channel
  adapters/
    http.ts                # POST /message, POST /restart, optional Bearer auth
    telegram.ts            # Telegraf bot, long polling, required user allowlist
```

**ProcessManager** is the only file with real complexity. One persistent `claude` process per channel, lazy-spawned, with FIFO queuing (one-at-a-time dispatch to avoid corrupting the NDJSON stream), auto-restart on crash, and configurable timeout.

**Adapters** are thin — translate channel protocol to `processManager.send(channel, text)` and return the result.

## Protocol

Messages in (NDJSON on stdin):
```json
{"type":"user","message":{"role":"user","content":"hello"}}
```

Results out (NDJSON on stdout):
```json
{"type":"result","result":"Hello!","duration_ms":4200}
```

Process stays alive between messages. Session context preserved automatically.

## Self-restart

BAREclaw can restart itself to pick up code changes:

- `POST /restart` — HTTP endpoint
- `kill -HUP <pid>` — SIGHUP signal
- Claude can trigger either via Bash

On restart: all claude processes killed, HTTP server closed, new detached process spawned with same args. ~1-2s downtime.

## Build

```bash
npm run build   # compile to dist/
npm start       # run compiled JS
```

## Security notes

BAREclaw has shell access. Every channel that can reach it can run arbitrary commands.

- HTTP: set `BARECLAW_HTTP_TOKEN` for anything beyond localhost
- Telegram: `BARECLAW_ALLOWED_USERS` is mandatory — BAREclaw refuses to start without it
- All channels share the same `--allowedTools` set (no per-channel restrictions in V1)
