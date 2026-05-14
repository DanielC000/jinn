import { describe, it, expect } from "vitest";
import { parseTranscriptLine } from "../transcript-tail.js";

describe("parseTranscriptLine", () => {
  it("parses an assistant text block into text + text_snapshot deltas", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
    const deltas = parseTranscriptLine(line, "");
    expect(deltas.map((d) => d.type)).toEqual(["text", "text_snapshot"]);
    expect(deltas[0].content).toBe("Hello");
    expect(deltas[1].content).toBe("Hello");
  });

  it("accumulates text_snapshot across multiple assistant lines", () => {
    const l1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } });
    const l2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "world" }] } });
    const d1 = parseTranscriptLine(l1, "");
    const d2 = parseTranscriptLine(l2, d1[1].content);
    expect(d2[1].content).toBe("Hello world");
  });

  it("parses a tool_use block", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "t1" }] } });
    const deltas = parseTranscriptLine(line, "");
    expect(deltas[0].type).toBe("tool_use");
    expect(deltas[0].toolName).toBe("Bash");
  });

  it("parses a tool_result inside a user message", () => {
    const line = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
    const deltas = parseTranscriptLine(line, "");
    expect(deltas[0].type).toBe("tool_result");
  });

  it("ignores metadata lines and unparseable lines", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "custom-title" }), "")).toEqual([]);
    expect(parseTranscriptLine("{not json", "")).toEqual([]);
    expect(parseTranscriptLine("", "")).toEqual([]);
  });
});
