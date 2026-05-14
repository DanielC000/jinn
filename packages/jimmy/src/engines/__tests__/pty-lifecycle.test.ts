import { describe, it, expect } from "vitest";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

describe("PtyLifecycleManager", () => {
  it("registers a PTY and reports it as warm", () => {
    const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-1", h, { cronOrigin: false });
    expect(m.getWarm("sess-1")).toBe(h);
  });

  it("releaseSession kills the PTY, cleans the handle, and fires onCleanup", () => {
    let cleaned = "";
    const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8, onCleanup: (id) => { cleaned = id; } });
    const h = fakeHandle();
    m.adopt("sess-2", h, { cronOrigin: false });
    m.releaseSession("sess-2");
    expect(h.killed).toBe(true);
    expect(m.getWarm("sess-2")).toBeUndefined();
    expect(cleaned).toBe("sess-2");
  });

  it("a cron-origin PTY is killed on turnEnded even if keepAlive is requested", () => {
    const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-3", h, { cronOrigin: true });
    m.setKeepAlive("sess-3", true);
    m.turnEnded("sess-3");
    expect(h.killed).toBe(true);
  });

  it("a keepAlive non-cron PTY survives turnEnded", () => {
    const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-4", h, { cronOrigin: false });
    m.setKeepAlive("sess-4", true);
    m.turnEnded("sess-4");
    expect(h.killed).toBe(false);
  });

  it("isAtCapacity is true once maxLivePtys is reached", () => {
    const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 2 });
    m.adopt("a", fakeHandle(), { cronOrigin: false });
    m.adopt("b", fakeHandle(), { cronOrigin: false });
    expect(m.isAtCapacity()).toBe(true);
  });

  it("markViewed extends life past turnEnded within the grace window", () => {
    const m = new PtyLifecycleManager({ graceWindowMs: 60_000, idleTimeoutMs: 600_000, maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-5", h, { cronOrigin: false });
    m.markViewed("sess-5");
    m.turnEnded("sess-5");
    expect(h.killed).toBe(false);
  });

  it("killAll kills every live PTY", () => {
    const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
    const a = fakeHandle(), b = fakeHandle();
    m.adopt("a", a, { cronOrigin: false });
    m.adopt("b", b, { cronOrigin: false });
    m.killAll();
    expect(a.killed).toBe(true);
    expect(b.killed).toBe(true);
  });
});
