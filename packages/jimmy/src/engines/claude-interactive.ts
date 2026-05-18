import fs from "node:fs";
import fsp from "node:fs/promises";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, EngineRateLimitInfo, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";
import { writeSessionSettings } from "../shared/claude-settings.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";

interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
}

interface TranscriptUsage { inputTokens: number; outputTokens: number; cacheTokens: number; assistantTurns: number; }

interface TranscriptTailer {
  stop(): void;
}

// $/million tokens. Conservative defaults.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

function sumTranscriptUsage(content: string): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0 };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

function computeInteractiveCost(transcriptPath: string, model?: string): { cost: number; turns: number } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content);
  if (u.assistantTurns === 0) return null;
  const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
  const cost = (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out;
  return { cost, turns: u.assistantTurns };
}

/**
 * Map a StopFailure hook payload to an EngineRateLimitInfo.
 * Returns null unless the turn failed specifically with error === "rate_limit".
 * The shape matches what ClaudeEngine produces from `rate_limit_event` JSON, so
 * detectRateLimit() / the wait-retry machinery in manager.ts work unchanged.
 * (error_details may carry a reset time, but its format is unconfirmed — left
 * unparsed; manager.ts computes a default backoff when resetsAt is absent.)
 */
function rateLimitFromStopFailure(payload: HookPayload | undefined): EngineRateLimitInfo | null {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  return { status: "rejected", rateLimitType: "interactive_detected" };
}

function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += "\n\nAttached files:\n" + o.attachments.map((a) => `- ${a}`).join("\n");
  }
  args.push(prompt); // positional — MUST precede variadic --mcp-config

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--settings", o.settingsPath);
  if (o.cliFlags?.length) args.push(...o.cliFlags);
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  return args;
}

/**
 * Parse one transcript JSONL line into StreamDeltas.
 * Emits `text` deltas (incremental) and tool_use/tool_result markers. We intentionally
 * do NOT emit `text_snapshot` deltas here — those were a defense against `claude -p`'s
 * dropped-token streaming. Interactive mode tails the transcript file (append-only,
 * no drops), so cumulative snapshots are pure quadratic overhead.
 */
function parseTranscriptLine(line: string): StreamDelta[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return []; }

  const out: StreamDelta[] = [];
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return out;

  if (msg.type === "assistant") {
    let text = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "tool_use") {
        out.push({ type: "tool_use", content: `Using ${block.name ?? "tool"}`, toolName: String(block.name ?? "tool"), toolId: String(block.id ?? "") });
      }
    }
    if (text) {
      out.push({ type: "text", content: text });
    }
  } else if (msg.type === "user") {
    for (const block of content) {
      if (block.type === "tool_result") out.push({ type: "tool_result", content: "" });
    }
  }
  return out;
}

/** Tail a transcript file, emitting StreamDeltas for each appended line.
 *  Uses async fs.promises so a slow disk read never blocks the event loop
 *  (which would stall the hook server, PTY data callbacks, and every other
 *  in-flight WS / HTTP handler). A single fd is kept open across reads and
 *  reused; readNew() guards against re-entry with a queued flag so two
 *  rapid fs.watch events can't race on the same fd. */
function tailTranscript(filePath: string, onDelta: (d: StreamDelta) => void): TranscriptTailer {
  let offset = 0;
  try { offset = fs.statSync(filePath).size; } catch { /* file may not exist yet; offset stays 0 */ }
  let buf = "";
  let stopped = false;
  let fh: fsp.FileHandle | undefined;
  let reading = false;
  let pending = false;

  const ensureOpen = async (): Promise<fsp.FileHandle | undefined> => {
    if (fh) return fh;
    try { fh = await fsp.open(filePath, "r"); } catch { return undefined; }
    return fh;
  };

  const readNew = async (): Promise<void> => {
    if (stopped) return;
    if (reading) { pending = true; return; }
    reading = true;
    try {
      do {
        pending = false;
        let stat: fs.Stats;
        try { stat = await fsp.stat(filePath); } catch { return; }
        if (stat.size <= offset) return;
        const handle = await ensureOpen();
        if (!handle || stopped) return;
        const size = stat.size - offset;
        const chunk = Buffer.alloc(size);
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(chunk, 0, size, offset));
        } catch (err) {
          // Read failure (disk error, revoked fd, etc.) leaves the cached fh in
          // an unusable state — close+null it so the next watcher event re-opens
          // the file cleanly instead of looping forever on a dead fd.
          try { await handle.close(); } catch { /* already gone */ }
          if (fh === handle) fh = undefined;
          logger.warn(`tailTranscript read failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        offset += bytesRead;
        buf += chunk.subarray(0, bytesRead).toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          for (const d of parseTranscriptLine(l)) {
            onDelta(d);
          }
        }
      } while (pending && !stopped);
    } finally {
      reading = false;
    }
  };

  let watcher: fs.FSWatcher | undefined;
  try { watcher = fs.watch(filePath, () => { void readNew(); }); } catch { /* file may not exist yet */ }
  // One-shot drain shortly after attach in case the file was appended between
  // SessionStart hook and watcher install. NOT a poll — just a single catch-up.
  const initialDrain = setTimeout(() => { void readNew(); }, 30);
  initialDrain.unref();
  // Do NOT initial-drain at offset 0 — that would replay the resumed conversation
  // history as fresh deltas. fs.watch picks up new appends from `offset` onward.

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearTimeout(initialDrain);
      // Close the fd off-thread; nothing waits on this.
      void fh?.close().catch(() => { /* ignore */ });
      fh = undefined;
    },
  };
}

export interface TurnResolverOpts {
  turnTimeoutMs: number;
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt/timeout. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private timer: NodeJS.Timeout;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    this.timer = setTimeout(() => this.settle({
      sessionId: opts.fallbackSessionId ?? "",
      result: "",
      error: "Interactive turn timed out (watchdog)",
    }), opts.turnTimeoutMs);
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn (rate_limit, billing_error, …). Settle immediately
      // with an error — do NOT wait for SessionStart (an early failure may never
      // produce one). numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.settle({
        sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
        result: "",
        error: `Interactive turn failed: ${h.error ?? "unknown"}`,
        numTurns: 1,
      });
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    const text = String(this.stopPayload.last_assistant_message ?? "");
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.resolve(r);
  }
}

/** Cap for the per-session PTY scrollback ring buffer (xterm.js reconnect replay). */
const SCROLLBACK_CAP_BYTES = 262144;

/** Bracketed-paste `text` into a PTY then submit with CR after a 50ms beat.
 *  Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
 *  they still trigger the slash-command / mention / bash-mode handlers and the
 *  turn is never submitted. Prepend a space so it's treated as a literal message.
 *  Shared by injectPrompt() (warm-PTY first turn) and writeStdin() (raw WS input). */
function pasteAndSubmit(proc: pty.IPty, text: string): void {
  let payload = text;
  if (/^[/@!]/.test(payload)) payload = " " + payload;
  proc.write(`\x1b[200~${payload}\x1b[201~`);
  setTimeout(() => proc.write("\r"), 50);
}

/** Out-of-band control event for PTY subscribers. Currently only `reset` (emitted
 *  when the PTY respawns mid-session so the client xterm can clear and re-attach). */
export type PtyControlEvent = { type: "reset" };

export class InteractiveClaudeEngine implements InterruptibleEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. */
  private active = new Map<string, { resolver: TurnResolver; tailer?: TranscriptTailer }>();
  /** Per-session PTY output streams: scrollback ring buffer (chunk list + running byte total)
   *  + live subscribers. Survives PTY respawn. The chunk-list ring avoids the O(N) realloc
   *  that a `(buffer + d).slice(-CAP)` per data event would cause at hot output. */
  private streams = new Map<string, {
    chunks: Buffer[];
    totalBytes: number;
    subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
    /** Set to true the first time a PTY is wired to this stream entry. Subsequent
     *  wires (subscribers attached or not) are PTY respawns — clients need a reset
     *  so their xterm doesn't render the new alt-screen atop the old one's cells. */
    hasSeenPty: boolean;
  }>();

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
    private cfg: { turnTimeoutMs: number },
  ) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      appendSystemPrompt: opts.systemPrompt,
    });

    const warm = this.lifecycle.getWarm(jinnSessionId);
    const resolver = new TurnResolver({
      turnTimeoutMs: this.cfg.turnTimeoutMs,
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
    });
    const entry: { resolver: TurnResolver; tailer?: TranscriptTailer } = { resolver };
    this.active.set(jinnSessionId, entry);

    // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
    this.hookRegistry.register(jinnSessionId, (h) => {
      resolver.onHook(h);
      if (h.hook_event_name === "SessionStart" && typeof h.transcript_path === "string" && !entry.tailer) {
        entry.tailer = tailTranscript(h.transcript_path, (d) => opts.onStream?.(d));
      }
      if ((h.hook_event_name === "PreToolUse" || h.hook_event_name === "PostToolUse") && opts.onStream) {
        opts.onStream({
          type: h.hook_event_name === "PreToolUse" ? "tool_use" : "tool_result",
          content: String(h.tool_name ?? ""),
          toolName: typeof h.tool_name === "string" ? h.tool_name : undefined,
        });
      }
    });

    if (warm) {
      // Mark the turn started BEFORE injecting so the sweep timer can't
      // theoretically release the PTY mid-paste if its grace window expired
      // between getWarm() above and the proc.write() inside injectPrompt.
      this.lifecycle.turnStarted(jinnSessionId);
      this.injectPrompt(warm, opts);
    } else {
      const handle = this.spawn(jinnSessionId, opts, settingsPath);
      this.lifecycle.adopt(jinnSessionId, handle, { cronOrigin: opts.source === "cron" });
      this.lifecycle.turnStarted(jinnSessionId);
    }

    let result: EngineResult;
    try {
      result = await resolver.promise;
    } finally {
      entry.tailer?.stop();
      this.hookRegistry.unregister(jinnSessionId);
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId); // manager decides kill vs keep-warm
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      const cost = computeInteractiveCost(transcriptPath, opts.model);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    return result;
  }

  /** Build the env passed to the claude PTY: inherits process.env but strips
   *  CLAUDECODE / CLAUDE_CODE_* so the child doesn't think it's nested, then
   *  enables fullscreen rendering. Shared by spawn() and ensureIdleSpawn(). */
  private buildPtyEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CODE_NO_FLICKER = "1"; // fullscreen mode — discrete bottom slot for CLI rendering
    return env;
  }

  /** Wrap a freshly-spawned pty.IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. Optional onExitExtra
   *  runs on PTY exit (spawn() uses this to interrupt the active resolver). */
  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, onExitExtra?: () => void): PtyHandle {
    const handle: PtyHandle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
    } as PtyHandle;
    const stream = this.streamFor(jinnSessionId);
    // Distinguish initial spawn from respawn via a per-stream flag rather than
    // subscriber count — CliTerminal opens its WS on mount (before the user
    // sends the first message that triggers spawn), so subscriber-count gating
    // would spuriously reset on the very first PTY for the session.
    // On respawn, only emit if there are subscribers (no one listens otherwise).
    if (!stream.hasSeenPty) {
      stream.hasSeenPty = true;
    } else if (stream.subscribers.size > 0) {
      for (const sub of stream.subscribers) {
        try { sub.control?.({ type: "reset" }); } catch { /* ignore */ }
      }
    }
    proc.onData((d) => {
      // Convert string to Buffer once; push to ring; evict head until under cap.
      const chunk = Buffer.from(d, "utf-8");
      stream.chunks.push(chunk);
      stream.totalBytes += chunk.length;
      while (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length > 1) {
        const head = stream.chunks.shift()!;
        stream.totalBytes -= head.length;
      }
      // If a single chunk exceeds the cap, slice it down (rare; keeps invariant tight).
      if (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length === 1) {
        const only = stream.chunks[0]!;
        const sliced = only.subarray(only.length - SCROLLBACK_CAP_BYTES);
        stream.chunks[0] = sliced;
        stream.totalBytes = sliced.length;
      }
      for (const sub of stream.subscribers) {
        try { sub.data(chunk); } catch { /* ignore subscriber errors */ }
      }
    });
    proc.onExit(() => {
      // Clear scrollback so a stale farewell (Claude's "Resume this session…" hint
      // printed on SIGHUP shutdown) doesn't persist into the next PTY incarnation.
      const s = this.streams.get(jinnSessionId);
      if (s) {
        s.chunks = [];
        s.totalBytes = 0;
        // If no WS subscribers are attached, the entry is dead weight — drop it so
        // the map doesn't leak entries for every session that ever ran. Subscribers,
        // when present, are kept so a future respawn can notify them via Task 4's
        // reset event; that path also clears the subscribers Set on full teardown.
        if (s.subscribers.size === 0) {
          this.streams.delete(jinnSessionId);
        }
      }
      // Release the lifecycle entry so the dead handle isn't picked up by a future
      // run() as "warm" — that would inject into a corpse.
      this.lifecycle.releaseSession(jinnSessionId);
      onExitExtra?.();
    });
    (handle as any)._proc = proc;
    return handle;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli). */
  private spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string): PtyHandle {
    const args = buildInteractiveArgs({
      prompt: opts.prompt,
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
    });
    const env = this.buildPtyEnv();
    const bin = opts.bin || "claude";
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    return this.wireProcToStream(jinnSessionId, proc, () => {
      // PTY exited without a Stop hook (crash / early exit) — settle as interrupted.
      const e = this.active.get(jinnSessionId);
      e?.resolver.interrupt("Interrupted: claude process exited");
    });
  }

  /** Spawn an idle PTY that just loads the TUI on an existing Claude session id (no prompt → no turn).
   *  Used by /ws/pty/:sessionId so opening a CLI-mode chat shows the conversation history.
   *  Does NOTHING if a warm PTY already exists for the session. Does NOTHING if claudeSessionId is empty. */
  ensureIdleSpawn(jinnSessionId: string, opts: { claudeSessionId: string; cwd?: string; model?: string; bin?: string }): void {
    if (!opts.claudeSessionId) return;
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting/running — let run() spawn
    // Spawn claude in PTY with --resume <id>, no prompt. Include --settings so hooks fire for future turns.
    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
    });
    const args: string[] = [
      "--resume", opts.claudeSessionId,
      "--chrome",
      "--dangerously-skip-permissions",
      "--settings", settingsPath,
    ];
    if (opts.model) args.push("--model", opts.model);
    const env = this.buildPtyEnv();
    const bin = opts.bin || "claude";
    logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.claudeSessionId})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    const handle = this.wireProcToStream(jinnSessionId, proc);
    this.lifecycle.adopt(jinnSessionId, handle, { cronOrigin: false });
    this.lifecycle.markViewed(jinnSessionId); // grace-period applies — keeps it warm while user views
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let text = opts.prompt;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    pasteAndSubmit(proc, text);
  }

  /** Lazily create (or fetch) the output stream entry for a Jinn session id. */
  private streamFor(sessionId: string): {
    chunks: Buffer[];
    totalBytes: number;
    subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
    hasSeenPty: boolean;
  } {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { chunks: [], totalBytes: 0, subscribers: new Set(), hasSeenPty: false };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /** Append-only capped output buffer for the session's current/most-recent PTY (for xterm.js reconnect replay).
   *  Returns a concatenated Buffer — pty-ws.ts forwards it directly without re-encoding. */
  getScrollback(sessionId: string): Buffer {
    const s = this.streams.get(sessionId);
    if (!s || s.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(s.chunks, s.totalBytes);
  }

  /** Subscribe to live PTY output for a session. Returns an unsubscribe fn. Survives PTY respawn within the session.
   *  Optional `onControl` receives out-of-band events (currently just `{type:"reset"}`
   *  when the PTY is replaced mid-session — the WS should forward this to the client xterm). */
  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    const stream = this.streamFor(sessionId);
    const sub = { data: cb, control: onControl };
    stream.subscribers.add(sub);
    return () => {
      stream.subscribers.delete(sub);
      // If this was the last subscriber AND there's no warm PTY producing data,
      // the streams entry is dead weight — drop it. Mirrors the onExit cleanup
      // path for sessions whose WS outlived the PTY.
      if (stream.subscribers.size === 0 && !this.lifecycle.getWarm(sessionId)) {
        this.streams.delete(sessionId);
      }
    };
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  /** Resize the warm PTY. No-op if no warm PTY. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Toggle KEEP ALIVE for a session — forwards to the PTY lifecycle manager. */
  setKeepAlive(sessionId: string, on: boolean): void {
    this.lifecycle.setKeepAlive(sessionId, on);
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Refresh the lifecycle's lastViewedAt for the session (called when a browser tab
   *  views/interacts with the CLI terminal — keeps the warm PTY in the grace window). */
  markViewed(sessionId: string): void {
    this.lifecycle.markViewed(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
