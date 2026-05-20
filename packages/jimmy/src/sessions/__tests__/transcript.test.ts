import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, expect } from "vitest";
import { findTranscriptPath, loadTranscriptMessages } from "../transcript.js";

describe("transcript reader", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-transcript-test-"));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserprofile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("findTranscriptPath returns null when projects dir missing", () => {
    expect(findTranscriptPath("nope")).toBeNull();
  });

  test("findTranscriptPath locates jsonl across project dirs", () => {
    const projectDir = path.join(tmpHome, ".claude", "projects", "-foo-bar");
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, "abc.jsonl");
    fs.writeFileSync(jsonlPath, "");
    expect(findTranscriptPath("abc")).toBe(jsonlPath);
  });

  test("loadTranscriptMessages parses string-content user/assistant frames", () => {
    const projectDir = path.join(tmpHome, ".claude", "projects", "-p");
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      JSON.stringify({ type: "assistant", message: { content: "hi back" } }),
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "s1.jsonl"), lines);
    const msgs = loadTranscriptMessages("s1");
    expect(msgs).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi back" },
    ]);
  });

  test("loadTranscriptMessages handles array content with text blocks", () => {
    const projectDir = path.join(tmpHome, ".claude", "projects", "-p");
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Here's the answer: " },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: "done." },
          ],
        },
      }),
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "s2.jsonl"), lines);
    const msgs = loadTranscriptMessages("s2");
    expect(msgs).toEqual([{ role: "assistant", content: "Here's the answer: done." }]);
  });

  test("loadTranscriptMessages skips non-user/assistant frames and bad JSON", () => {
    const projectDir = path.join(tmpHome, ".claude", "projects", "-p");
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "ai-title", message: { content: "Skipped" } }),
      "{not json",
      JSON.stringify({ type: "user", message: { content: "keep" } }),
      JSON.stringify({ type: "assistant" }), // no message — skip
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "s3.jsonl"), lines);
    expect(loadTranscriptMessages("s3")).toEqual([{ role: "user", content: "keep" }]);
  });

  test("loadTranscriptMessages returns empty array when transcript missing", () => {
    expect(loadTranscriptMessages("doesnt-exist")).toEqual([]);
  });
});
