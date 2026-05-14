import { describe, it, expect } from "vitest";
import { normalizeClaudeEngineConfig } from "../config.js";

describe("normalizeClaudeEngineConfig", () => {
  it("defaults mode to headless when missing", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus" });
    expect(out.mode).toBe("headless");
  });

  it("coerces a garbage mode to headless", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", mode: "banana" as any });
    expect(out.mode).toBe("headless");
  });

  it("keeps a valid interactive mode and applies timeout defaults", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", mode: "interactive" });
    expect(out.mode).toBe("interactive");
    expect(out.idleTimeoutMs).toBe(1_800_000);
    expect(out.graceWindowMs).toBe(300_000);
    expect(out.turnTimeoutMs).toBe(600_000);
    expect(out.maxLivePtys).toBe(8);
  });
});
