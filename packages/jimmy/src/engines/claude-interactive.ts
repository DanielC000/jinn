import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";
import { writeSessionSettings } from "../shared/claude-settings.js";
import { buildInteractiveArgs } from "./interactive-args.js";
import { tailTranscript, type TranscriptTailer } from "./transcript-tail.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
// NOTE: cost + rate-limit reconstruction is wired in by Task 5.3 (modifies run()).

export interface TurnResolverOpts { turnTimeoutMs: number; fallbackSessionId: string | undefined; }

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

export class InteractiveClaudeEngine implements InterruptibleEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. */
  private active = new Map<string, { resolver: TurnResolver; tailer?: TranscriptTailer }>();

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

    const resolver = new TurnResolver({ turnTimeoutMs: this.cfg.turnTimeoutMs, fallbackSessionId: opts.resumeSessionId });
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

    const warm = this.lifecycle.getWarm(jinnSessionId);
    if (warm) {
      this.injectPrompt(warm, opts);
      this.lifecycle.turnStarted(jinnSessionId);
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

    // Task 5.3 inserts cost + rate-limit reconstruction here, using
    // `resolver.transcriptPath` / `resolver.stopFailure`. For now return as-is.
    return result;
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
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CODE_NO_FLICKER = "1"; // fullscreen mode — discrete bottom slot for CLI rendering
    const bin = opts.bin || "claude";
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    const handle: PtyHandle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
    } as PtyHandle;
    proc.onExit(() => {
      // PTY exited without a Stop hook (crash / early exit) — settle as interrupted.
      const e = this.active.get(jinnSessionId);
      e?.resolver.interrupt("Interrupted: claude process exited");
    });
    (handle as any)._proc = proc;
    return handle;
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let text = opts.prompt;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    // Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
    // they still trigger the slash-command / mention / bash-mode handlers and the
    // turn is never submitted. Prepend a space so it's treated as a literal message.
    if (/^[/@!]/.test(text)) text = " " + text;
    proc.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => proc.write("\r"), 50); // small delay before submit — see Task 0.1
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

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
