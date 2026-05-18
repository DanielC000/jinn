import { describe, it, expect } from "vitest";
import { pickEngineKey } from "../claude-routing-policy.js";

describe("pickEngineKey", () => {
  it("explicit interactive wins regardless of source", () => {
    expect(pickEngineKey({ source: "web", claudeVariant: "interactive" })).toBe("interactive");
    expect(pickEngineKey({ source: "cron", claudeVariant: "interactive" })).toBe("interactive");
    expect(pickEngineKey({ source: "slack", claudeVariant: "interactive" })).toBe("interactive");
    expect(pickEngineKey({ claudeVariant: "interactive" })).toBe("interactive");
  });

  it("explicit headless wins regardless of source", () => {
    expect(pickEngineKey({ source: "web", claudeVariant: "headless" })).toBe("headless");
    expect(pickEngineKey({ source: "cron", claudeVariant: "headless" })).toBe("headless");
  });

  it("no variant → headless (regardless of source)", () => {
    expect(pickEngineKey({})).toBe("headless");
    expect(pickEngineKey({ source: "cron" })).toBe("headless");
    expect(pickEngineKey({ source: "slack" })).toBe("headless");
    expect(pickEngineKey({ source: "discord" })).toBe("headless");
    expect(pickEngineKey({ source: "telegram" })).toBe("headless");
  });

  it("web with no variant → headless (chat mode default)", () => {
    expect(pickEngineKey({ source: "web" })).toBe("headless");
  });

  it("cron with variant=interactive (variant wins) → interactive", () => {
    expect(pickEngineKey({ source: "cron", claudeVariant: "interactive" })).toBe("interactive");
  });
});
