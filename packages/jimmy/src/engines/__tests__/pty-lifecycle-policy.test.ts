import { describe, it, expect } from "vitest";
import { shouldStayAlive } from "../pty-lifecycle-policy.js";

const base = { turnRunning: false, keepAlive: false, lastViewedAt: 0, now: 1_000_000, graceWindowMs: 300_000, cronOrigin: false };

describe("shouldStayAlive", () => {
  it("stays alive while a turn is running", () => {
    expect(shouldStayAlive({ ...base, turnRunning: true })).toBe(true);
  });
  it("stays alive when KEEP ALIVE is set and not cron-origin", () => {
    expect(shouldStayAlive({ ...base, keepAlive: true })).toBe(true);
  });
  it("ignores KEEP ALIVE for cron-origin sessions", () => {
    expect(shouldStayAlive({ ...base, keepAlive: true, cronOrigin: true })).toBe(false);
  });
  it("stays alive within the grace window after a recent view", () => {
    expect(shouldStayAlive({ ...base, lastViewedAt: 1_000_000 - 100_000 })).toBe(true);
  });
  it("dies once the grace window has elapsed", () => {
    expect(shouldStayAlive({ ...base, lastViewedAt: 1_000_000 - 400_000 })).toBe(false);
  });
  it("idle session with nothing set dies", () => {
    expect(shouldStayAlive(base)).toBe(false);
  });
});
