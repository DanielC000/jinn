import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import type { ClaudeEngine } from "./claude.js";
import type { InteractiveClaudeEngine } from "./claude-interactive.js";
import { pickEngineKey } from "./claude-routing-policy.js";

/**
 * Per-call routing wrapper around the headless ClaudeEngine and InteractiveClaudeEngine.
 *
 * Routes turns to either engine based on EngineRunOpts.claudeVariant (and source as a
 * fallback). Web "cli" mode sends claudeVariant="interactive" → PTY-backed turn; everything
 * else (cron/connectors, web "chat" mode) uses headless `claude -p`.
 */
export class RoutingClaudeEngine implements InterruptibleEngine {
  name = "claude" as const;
  constructor(
    private headless: ClaudeEngine,
    private interactive: InteractiveClaudeEngine,
  ) {}

  /** The underlying interactive engine — used by /ws/pty, setKeepAlive, fork. */
  getInteractive(): InteractiveClaudeEngine {
    return this.interactive;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const key = pickEngineKey({ source: opts.source, claudeVariant: opts.claudeVariant });
    return key === "interactive" ? this.interactive.run(opts) : this.headless.run(opts);
  }

  kill(sessionId: string, reason?: string): void {
    // Kill in both — a session could have been routed to either engine across turns.
    // Each kill is a safe no-op when nothing's running for the session in that engine.
    this.headless.kill(sessionId, reason);
    this.interactive.kill(sessionId, reason);
  }

  killAll(): void {
    this.headless.killAll();
    this.interactive.killAll();
  }

  isAlive(sessionId: string): boolean {
    return this.headless.isAlive(sessionId) || this.interactive.isAlive(sessionId);
  }

  /** Forwarded so `"isTurnRunning" in engine` feature-detection in api.ts works. */
  isTurnRunning(sessionId: string): boolean {
    return this.interactive.isTurnRunning(sessionId);
  }

  /** Forwarded so the KEEP ALIVE API handler can flip it via `"setKeepAlive" in engine`. */
  setKeepAlive(sessionId: string, on: boolean): void {
    this.interactive.setKeepAlive(sessionId, on);
  }
}
