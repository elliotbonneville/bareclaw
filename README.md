# BAREclaw

One daemon, many mouths, one brain. The bare minimum between you and your AI.

BAREclaw is a thin daemon that multiplexes input channels (HTTP, Telegram, SMS, etc.) into a persistent Claude Code CLI process. Every channel gets its own session with full context, tools, skills, MCP servers, and CLAUDE.md. Responses come back out the same way they came in.

The key design choice: BAREclaw shells out to `claude -p` rather than using the Agent SDK. CLI shelling goes through the Claude Max subscription (flat-rate unlimited). The SDK bills per API token. For a personal daemon, the marginal cost is $0.

The key design consequence: Claude running through BAREclaw has full tool access, including `Bash`, `Write`, and `Edit`. It can modify BAREclaw's own source code and trigger a restart to pick up the changes. BAREclaw is the simplest thing that could build itself.

## Quick start

```bash
# Clone and install
cd ~/dev/tools/bareclaw
npm install

# Configure (optional — works with zero config for localhost)
cp .env.example .env
# edit .env if you want to change defaults or add Telegram

# Run
npm run dev
```

The server starts on port 3000. Send it a message:

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "hello"}'
```

Response:

```json
{
  "text": "Hello! How can I help you today?",
  "duration_ms": 4200
}
```

The first message on a channel is slow (~15-30s) because it spawns a new `claude` process. Subsequent messages reuse the warm process and typically respond in 3-5s.

## How it works

BAREclaw spawns one persistent `claude` process per channel. Each process runs in stream-JSON mode:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --max-turns 25 --allowedTools Read,Glob,Grep,Bash,Write,Edit
```

Messages go in as NDJSON on stdin:

```json
{"type":"user","message":{"role":"user","content":"hello"}}
```

Events come back as NDJSON on stdout. BAREclaw waits for the `result` event:

```json
{"type":"result","result":"Hello! How can I help you...","duration_ms":4200}
```

This is the same protocol validated in `test-stream.js`. The process stays alive between messages, so session context (conversation history, tool state) is preserved automatically — no `--resume` flags, no session storage.

## Architecture

```
[curl / Shortcut / Telegram / SMS / ...]
    → adapter (translates channel protocol → internal API)
        → ProcessManager.send(channel, text)
            → persistent claude process (one per channel)
        ← { text, duration_ms }
    ← response via same channel
```

### Process manager (`src/core/process-manager.ts`)

The only file with real complexity. Manages the lifecycle of persistent `claude` processes.

**One process per channel.** The `channels` map holds a `ManagedProcess` for each active channel (e.g. `"http"`, `"telegram"`). Each process has its own conversation context — messages sent on one channel don't leak into another.

**Lazy spawn.** Processes are created on first use. If you never send a Telegram message, no Telegram process is ever spawned.

**One-at-a-time dispatch.** Each channel has a `busy` flag and a FIFO queue. When a message arrives while the process is handling a previous one, it gets queued and dispatched in order after the current result arrives. This prevents interleaving NDJSON writes, which would corrupt the stream.

**Auto-restart.** When a process exits (crash, timeout kill, `--max-turns` exhaustion), the channel entry is cleared. The next `send()` call spawns a fresh process. Queued messages for a dead process are rejected with an error.

**Timeout.** Each dispatch has a 120s timer (configurable via `BARECLAW_TIMEOUT_MS`). If no `result` event arrives in time, the process is killed and the promise is rejected. This prevents hung processes from blocking a channel forever.

**Graceful shutdown.** `shutdown()` kills all child processes and clears the channel map. Called on SIGTERM/SIGINT.

### Adapters

Adapters are thin translation layers. Each one speaks a different protocol on the outside and calls `processManager.send(channel, text)` on the inside.

**HTTP** (`src/adapters/http.ts`) — An Express router with two endpoints:

```
POST /message
Body: { "text": "...", "channel": "http" }
Response: { "text": "...", "duration_ms": 4200 }

POST /restart
Response: { "status": "restarting" }
```

The `channel` field is optional (defaults to `"http"`). All HTTP requests share one process/session unless you pass a different channel name. This means Apple Shortcuts, curl, and any other HTTP client all talk to the same Claude session — which is usually what you want.

If you want isolated sessions from HTTP, pass a channel name:

```bash
# These two requests talk to different Claude processes:
curl ... -d '{"text": "...", "channel": "work"}'
curl ... -d '{"text": "...", "channel": "journal"}'
```

**Telegram** (`src/adapters/telegram.ts`) — A Telegraf bot using long polling (no webhook server needed). All Telegram messages go to the `"telegram"` channel, sharing one process/session.

Features:
- Required user ID allowlist (`BARECLAW_ALLOWED_USERS`) — BAREclaw refuses to start Telegram without it
- Typing indicator sent immediately and refreshed every 4s while waiting for a response
- Replies formatted as Markdown, with automatic plain-text fallback if Telegram's Markdown parser rejects the response

## Authentication

BAREclaw has shell access to your machine. Every channel that can reach it can run arbitrary commands. Auth is therefore mandatory for any non-localhost channel and strongly recommended everywhere.

### HTTP: Bearer token

Set `BARECLAW_HTTP_TOKEN` to any secret string. When set, all HTTP requests must include the header:

```
Authorization: Bearer <token>
```

Requests without it get a `401 Unauthorized` response. This applies to both `/message` and `/restart`.

```bash
# With auth enabled:
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer my-secret-token' \
  -d '{"text": "hello"}'
```

If `BARECLAW_HTTP_TOKEN` is unset, HTTP is unauthenticated. This is fine for localhost-only access behind Tailscale, but understand that anyone who can reach port 3000 has shell access.

### Telegram: Required allowlist

When Telegram is enabled (`BARECLAW_TELEGRAM_TOKEN` is set), `BARECLAW_ALLOWED_USERS` is **required**. BAREclaw will refuse to start if the allowlist is empty. This is intentional — an open Telegram bot with Bash access is an open door to your machine.

Messages from users not on the allowlist are silently dropped.

### Per-channel tool restrictions (not in V1)

All channels currently get the same `--allowedTools` set. A future version could restrict tools per channel (e.g. read-only for Telegram, full access for localhost HTTP). For now, auth is the gate — not tool restrictions.

## Self-restart

BAREclaw can restart itself to pick up code or config changes. This is what makes it a living system: Claude running through BAREclaw can edit its own source files, then trigger a restart.

Three ways to restart:

**HTTP endpoint:**
```bash
curl -X POST localhost:3000/restart \
  -H 'Authorization: Bearer <token>'
```

**SIGHUP signal:**
```bash
kill -HUP $(pgrep -f 'tsx src/index.ts')
```

**From Claude itself** — via Bash tool, Claude can run either of the above. A typical self-modification flow:

1. You message Claude (via any channel): "add a /health endpoint to BAREclaw"
2. Claude edits `src/adapters/http.ts`
3. Claude runs `curl -X POST localhost:3000/restart`
4. BAREclaw shuts down all `claude` processes, closes the HTTP server, and re-execs itself
5. The new process starts with the updated code
6. Your next message hits the new version

The restart is graceful: all child processes are killed, the HTTP server is closed, then a new detached process is spawned with the same arguments. The old process exits. There's a brief (~1-2s) window where the server is down.

Note: the `claude` process that triggered the restart gets killed as part of shutdown. The response to that specific message may not arrive. The next message starts a fresh session on the new code.

## Configuration

All configuration is via environment variables. Everything has a sensible default — BAREclaw works with zero config for localhost use.

| Variable | Default | Description |
|---|---|---|
| `BARECLAW_PORT` | `3000` | HTTP server port |
| `BARECLAW_CWD` | `$HOME` | Working directory for `claude` processes. Determines which `CLAUDE.md` and project context Claude sees. |
| `BARECLAW_MAX_TURNS` | `25` | Max agentic turns per message. Prevents runaway tool loops. |
| `BARECLAW_ALLOWED_TOOLS` | `Read,Glob,Grep,Bash,Write,Edit` | Tools auto-approved without interactive confirmation. Comma-separated. |
| `BARECLAW_TIMEOUT_MS` | `120000` | Per-message timeout in milliseconds. Process is killed if no result arrives in time. |
| `BARECLAW_HTTP_TOKEN` | *(none)* | Bearer token for HTTP auth. If unset, HTTP is unauthenticated. |
| `BARECLAW_TELEGRAM_TOKEN` | *(none)* | Telegram bot token from @BotFather. Omit to disable Telegram entirely. |
| `BARECLAW_ALLOWED_USERS` | *(none)* | Comma-separated Telegram user IDs. **Required** when Telegram is enabled. |

### Setting `BARECLAW_CWD`

This is the most important config option. It controls the project context for all `claude` processes:

- `~/dev/myproject` — Claude sees that project's `CLAUDE.md`, can read/edit its files, runs tools in that directory
- `~` — Claude sees your global `~/.claude/CLAUDE.md` and can access anything in your home directory
- `/tmp` — Sandboxed, no project context

For self-modification, set this to BAREclaw's own directory:

```bash
BARECLAW_CWD=~/dev/tools/bareclaw
```

Now Claude running through BAREclaw sees BAREclaw's `CLAUDE.md`, can edit its source files, and can restart itself. This is the "simplest thing that could build itself" configuration.

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot. Copy the token.
2. Get your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).
3. Set environment variables:
   ```bash
   BARECLAW_TELEGRAM_TOKEN=123456:ABC-DEF...
   BARECLAW_ALLOWED_USERS=your_user_id
   ```
4. Start BAREclaw. The bot connects via long polling — no public URL needed.

## Exposing to the internet

BAREclaw listens on localhost only. To reach it from your phone or other devices:

**Tailscale (recommended)** — If your devices are on a Tailnet, BAREclaw is already reachable at `http://your-machine:3000`. No config needed.

**Tailscale Funnel** — To expose to the public internet (e.g. for Telegram webhooks on a future version):

```bash
sudo tailscale funnel 3000
```

## File structure

```
bareclaw/
  package.json               # Dependencies: express, telegraf, tsx, typescript
  tsconfig.json              # ES2022, NodeNext, strict
  .env.example               # All config vars with defaults
  .gitignore                 # node_modules, dist, .env
  README.md
  docs/RESEARCH.md           # Design document and prior art
  test-stream.js             # Proof-of-concept that validates the core pattern
  test-stream-raw.js         # Raw stream-json test
  test-cli.sh                # CLI flag tests
  src/
    index.ts                 # Entry point: config, HTTP, Telegram, shutdown, self-restart
    config.ts                # Env var loading with defaults
    core/
      types.ts               # ClaudeInput, ClaudeResultEvent, SendMessageRequest, SendMessageResponse
      process-manager.ts     # Spawns/manages persistent claude processes (the core)
    adapters/
      http.ts                # POST /message, POST /restart, bearer token auth
      telegram.ts            # Telegraf bot with long polling, required allowlist
```

## What's not in V1

- **No persistent session storage.** Session lives in the process. If the process dies, context is lost and a new session starts.
- **No streaming responses to clients.** The HTTP endpoint and Telegram adapter wait for the full result before responding. Fine for most messages; long-running tool chains may feel slow.
- **No multi-user support.** One Telegram bot talks to one `claude` process. Multiple users would interleave their messages into the same session.
- **No per-channel tool restrictions.** All channels get the same `--allowedTools`. Auth is the access gate, not tool scoping.
- **No Docker.** Runs directly on your machine. Claude Code needs access to your filesystem and tools.

## Why not the Agent SDK?

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is the proper way to build agents programmatically. But it bills per API token — every prompt and response is metered.

BAREclaw shells out to `claude -p` instead, which routes through the **Claude Max subscription** (flat-rate unlimited). For a personal daemon that fields dozens of prompts a day, the marginal API cost is $0.

The tradeoff: you depend on the CLI's IPC protocol (stream-JSON over stdio), which is less stable than a versioned SDK API. For a personal tool, this is fine.

See `docs/RESEARCH.md` for the full design rationale, prior art, and future plans.
