# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Jinn

Lightweight AI gateway daemon that wraps Claude Code CLI, Codex SDK, and Gemini CLI behind a unified HTTP/WebSocket server. It routes tasks to AI engines, manages connectors (Slack, Discord, WhatsApp, Telegram), schedules cron jobs, and serves a React web dashboard. "A bus, not a brain" — zero custom AI logic, all intelligence delegated to the engine CLIs.

## Commands

```bash
pnpm install          # Install deps
pnpm setup            # One-time: build all + initialize ~/.jinn
pnpm dev              # Gateway (:7777) + Next.js dev server (:3000) with hot reload
pnpm build            # Compile TS + copy web/out → jimmy/dist/web
pnpm typecheck        # tsc --noEmit across all packages
pnpm test             # Vitest unit tests (all packages)
pnpm test:e2e         # Playwright E2E (requires gateway running)
pnpm stop             # Kill running gateway daemon
pnpm status           # Check if gateway is running
pnpm clean            # Delete build artifacts
```

Run a single test file:
```bash
cd packages/jimmy && pnpm test -- src/sessions/registry.test.ts
```

**Dev env note**: `pnpm dev` starts two processes — the gateway daemon on `:7777` and Next.js on `:3000`. Next.js proxies `/api/*` and `/ws` to `:7777`. Set `GATEWAY_PORT=<port>` to override the gateway port.

**Build pipeline**: `pnpm build` runs Turbo (jimmy compiles first, then web), then copies `packages/web/out/` into `packages/jimmy/dist/web/`. The gateway serves this static folder.

## Architecture

### Request flow

```
User message (web/Slack/Discord/Telegram/WhatsApp/Cron)
  → Connector (packages/jimmy/src/connectors/)
  → SessionManager (sessions/manager.ts)
  → Engine (engines/claude.ts | codex.ts | gemini.ts)  ← spawns CLI subprocess
  → StreamDelta events → connector reply / WebSocket push
```

### Gateway daemon (`src/gateway/`)

The daemon is the single process that owns all state. Key files:
- `server.ts` — HTTP + WebSocket server, serves static web files, routes requests
- `api.ts` — All REST route handlers (`/api/sessions`, `/api/org`, `/api/cron`, `/api/status`, etc.)
- `daemon-entry.ts` — Entry point when spawned as child process
- `lifecycle.ts` — Start/stop/restart logic, PID file management
- `watcher.ts` — Chokidar watchers for `config.yaml`, `cron/jobs.json`, `org/` (hot reload)
- `org.ts` + `org-hierarchy.ts` — Scans `~/.jinn/org/` YAML files, builds dependency graph
- `budgets.ts` — Per-session cost/duration limits

### Sessions (`src/sessions/`)

- `manager.ts` — Orchestrates engine dispatch: derives session key, looks up or creates session, enqueues if busy, calls engine, streams results back via `replyContext`. Tracks a per-session `contextVersion` to select full vs. minimal context; `invalidateContextCache()` forces a full rebuild on the next turn (called by org/cron file watchers).
- `registry.ts` — Synchronous SQLite wrapper (better-sqlite3). Tables: `sessions`, `messages`, `files`
- `context.ts` — Builds system prompt for a session. `buildContext()` does a full rebuild (org hierarchy, cron jobs, knowledge listing, env scan). `buildMinimalContext()` emits ESSENTIAL sections only (identity + session + config) with no filesystem I/O — used on resumed turns to keep the appended prompt small (~1–2 KB vs ~10–50 KB).
- `queue.ts` — Per-session queue; default concurrency = 1 (sequential turns)
- `fork.ts` — Spawns a child session when delegating to an employee
- `callbacks.ts` — Notifies parent session or connector when a forked session completes

**Session key derivation**: `<connector>:<channel/chat_id>:<user_id>` — connector implementations must produce stable, unique keys per conversation thread.

### Engines (`src/engines/`)

Each engine implements the `Engine` / `InterruptibleEngine` interface from `shared/types.ts`. They spawn the CLI as a child process and emit `StreamDelta` events via `opts.onStream`. Claude engine auto-retries transient errors (3 attempts, exponential backoff). Rate limit metadata is extracted from CLI output and returned in `EngineResult.rateLimit`.

### Connectors (`src/connectors/`)

Each connector implements the `Connector` interface. Key behavioral contract:
- `onMessage(handler)` registers the inbound handler; call it with `IncomingMessage` for every new message
- `replyMessage(target, text)` / `sendMessage(target, text)` sends back to the platform
- `reconstructTarget(replyContext)` recreates a `Target` from stored `replyContext` JSON (used when the gateway restarts between a request and its async reply)

Threading is connector-specific: Slack uses `thread_ts`, Discord uses `message_id + channel_id`, Telegram uses `message_id`.

### Cron (`src/cron/`)

- `scheduler.ts` — Registers node-cron jobs from `~/.jinn/cron/jobs.json`; the watcher hot-reloads this file
- `runner.ts` — Executes a single job: spawns a session (COO or delegated employee), optionally delivers output to a connector
- Run logs saved to `~/.jinn/cron/runs/<job-id>/<timestamp>.json`

### Org system (`src/gateway/org.ts`)

YAML files under `~/.jinn/org/<department>/` define AI employees. Fields include `rank`, `reportsTo`, `engine`, `model`, `persona`, `mcp`, `provides` (services). The org scanner builds a hierarchy graph used by `context.ts` to inject reporting chain into system prompts.

### MCP (`src/mcp/`)

- `resolver.ts` — Merges global MCP config with employee-specific overrides, writes a per-session `mcp.json`, passes it to the engine via `--mcp-config`
- `gateway-server.ts` — Built-in MCP server exposing gateway capabilities (messaging, org queries, cron) to agents

### Web dashboard (`packages/web/src/`)

Next.js 15 app router. Pages: `/chat`, `/sessions`, `/org`, `/cron`, `/kanban`, `/skills`, `/logs`, `/settings`. API calls go through `lib/api.ts` (fetch wrapper). TanStack Query for caching. Streaming responses use the `/api/sessions/:id/stream` SSE endpoint. The org map uses `@xyflow/react`.

## Key types (`src/shared/types.ts`)

All core interfaces live here: `Engine`, `InterruptibleEngine`, `EngineRunOpts`, `EngineResult`, `Connector`, `ConnectorCapabilities`, `IncomingMessage`, `Target`, `ReplyContext`, `StreamDelta`, `Session`, `CronJob`.

## Config (`~/.jinn/config.yaml`)

Loaded once on startup. Watched by chokidar — in-memory config updates on change, but connectors/engines are **not** restarted. Full effect requires gateway restart.

## Monorepo structure

pnpm workspaces + Turborepo. Two packages: `jinn-cli` (`packages/jimmy`) and `@jinn/web` (`packages/web`). `tsconfig.base.json` at root sets `strict: true`, `target: ES2022`, `module: NodeNext`. Each package extends it.
