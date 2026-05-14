import { describe, it, expect } from "vitest";
import { buildInteractiveArgs } from "../interactive-args.js";

describe("buildInteractiveArgs", () => {
  it("fresh session: prompt is positional, before --mcp-config", () => {
    const args = buildInteractiveArgs({
      prompt: "hi", settingsPath: "/s.json", model: "opus",
      effortLevel: "high", mcpConfigPath: "/m.json", cliFlags: ["--foo"],
    });
    expect(args.includes("hi")).toBe(true);
    expect(args.includes("--resume")).toBe(false);
    expect(args.includes("--chrome")).toBe(true);
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
    expect(args.indexOf("hi")).toBeLessThan(args.indexOf("--mcp-config"));
    expect(args.includes("--foo")).toBe(true);
  });

  it("resume session: --resume <id> precedes the positional prompt", () => {
    const args = buildInteractiveArgs({ prompt: "next", settingsPath: "/s.json", resumeSessionId: "abc" });
    expect(args.indexOf("--resume")).toBeLessThan(args.indexOf("abc"));
    expect(args.indexOf("abc")).toBeLessThan(args.indexOf("next"));
  });

  it("effort 'default' is omitted", () => {
    const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/s.json", effortLevel: "default" });
    expect(args.includes("--effort")).toBe(false);
  });

  it("attachments are appended to the prompt text", () => {
    const args = buildInteractiveArgs({ prompt: "look", settingsPath: "/s.json", attachments: ["/a.png"] });
    const promptArg = args.find((a) => a.startsWith("look"));
    expect(promptArg).toMatch(/Attached files:\n- \/a\.png/);
  });
});
