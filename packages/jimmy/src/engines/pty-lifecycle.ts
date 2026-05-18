import { shouldStayAlive } from "./pty-lifecycle-policy.js";

export interface PtyHandle {
  pid: number;
  killed: boolean;
  kill: (signal?: string) => void;
}

export interface PtyLifecycleOpts {
  graceWindowMs: number;
  idleTimeoutMs: number;
  maxLivePtys: number;
  /** Called after a new PTY session is adopted — used to refresh gateway.json pids. */
  onAdopt?: (sessionId: string) => void;
  /** Called after a PTY is killed/removed — used to clean the --settings file, hook registry, gateway.json pids. */
  onCleanup?: (sessionId: string) => void;
}

interface Entry {
  handle: PtyHandle;
  cronOrigin: boolean;
  keepAlive: boolean;
  turnRunning: boolean;
  lastViewedAt: number;
  lastActivityAt: number;
}

export class PtyLifecycleManager {
  private entries = new Map<string, Entry>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private opts: PtyLifecycleOpts) {
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  adopt(sessionId: string, handle: PtyHandle, meta: { cronOrigin: boolean }): void {
    this.entries.set(sessionId, {
      handle, cronOrigin: meta.cronOrigin, keepAlive: false,
      turnRunning: false, lastViewedAt: 0, lastActivityAt: Date.now(),
    });
    this.opts.onAdopt?.(sessionId);
  }

  getWarm(sessionId: string): PtyHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  isAtCapacity(): boolean {
    return this.entries.size >= this.opts.maxLivePtys;
  }

  livePids(): number[] {
    return [...this.entries.values()].map((e) => e.handle.pid);
  }

  setKeepAlive(sessionId: string, on: boolean): void {
    const e = this.entries.get(sessionId);
    if (e) { e.keepAlive = on; this.reevaluate(sessionId); }
  }

  markViewed(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) { e.lastViewedAt = Date.now(); e.lastActivityAt = Date.now(); }
  }

  turnStarted(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) { e.turnRunning = true; e.lastActivityAt = Date.now(); }
  }

  turnEnded(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.turnRunning = false;
    e.lastActivityAt = Date.now();
    this.reevaluate(sessionId);
  }

  releaseSession(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    if (!e.handle.killed) e.handle.kill("SIGTERM");
    this.opts.onCleanup?.(sessionId);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.releaseSession(id);
  }

  private reevaluate(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    const alive = shouldStayAlive({
      turnRunning: e.turnRunning,
      keepAlive: e.keepAlive,
      cronOrigin: e.cronOrigin,
      lastViewedAt: e.lastViewedAt,
      now: Date.now(),
      graceWindowMs: this.opts.graceWindowMs,
    });
    if (!alive) this.releaseSession(sessionId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of [...this.entries.entries()]) {
      if (now - e.lastActivityAt > this.opts.idleTimeoutMs) {
        this.releaseSession(id);
        continue;
      }
      this.reevaluate(id);
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.killAll();
  }
}
