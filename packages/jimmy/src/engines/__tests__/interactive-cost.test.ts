import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sumTranscriptUsage, computeInteractiveCost } from "../interactive-cost.js";

describe("interactive-cost", () => {
  it("sumTranscriptUsage sums usage across assistant lines", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: "user", message: { content: [] } }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 200, output_tokens: 80 } } }),
    ].join("\n");
    const u = sumTranscriptUsage(lines);
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(130);
    expect(u.assistantTurns).toBe(2);
  });

  it("dedupes assistant lines sharing a message.id (effort-high thinking+text split)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: "assistant", message: { id: "m2", usage: { input_tokens: 200, output_tokens: 80 } } }),
    ].join("\n");
    const u = sumTranscriptUsage(lines);
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(130);
    expect(u.assistantTurns).toBe(2);
  });

  it("computeInteractiveCost returns null for a missing transcript", () => {
    expect(computeInteractiveCost("/nope/x.jsonl", "opus")).toBe(null);
  });

  it("computeInteractiveCost produces a non-negative cost from a real transcript file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
    const f = path.join(dir, "t.jsonl");
    fs.writeFileSync(f, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1000, output_tokens: 500 } } }));
    const c = computeInteractiveCost(f, "claude-opus-4-7");
    expect(c && c.cost >= 0 && c.turns >= 1).toBe(true);
  });
});
