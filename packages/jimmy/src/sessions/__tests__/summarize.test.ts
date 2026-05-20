import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, expect } from "vitest";
import { summarizeSession } from "../summarize.js";
import type { Engine, EngineRunOpts, EngineResult, Session } from "../../shared/types.js";

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    engine: "claude",
    engineSessionId: "eng-1",
    source: "web",
    sourceRef: "web:s1",
    connector: null,
    sessionKey: "web:s1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    archivedAt: null,
    archivedTo: null,
    archivedFrom: null,
    summaryPrompt: null,
    autoSplitDisabled: false,
    ...overrides,
  };
}

/**
 * Stub engine that records the EngineRunOpts it received so tests can assert
 * exactly what the summarizer asked for.
 */
function makeStubEngine(result: Partial<EngineResult> = {}): { engine: Engine; calls: EngineRunOpts[] } {
  const calls: EngineRunOpts[] = [];
  const engine: Engine = {
    name: "claude",
    async run(opts: EngineRunOpts): Promise<EngineResult> {
      calls.push(opts);
      return {
        sessionId: opts.sessionId ?? "eng-out",
        result: result.result ?? "# Prior conversation summary\n\n## Goals\n- ok\n",
        cost: result.cost ?? 0,
        durationMs: result.durationMs ?? 0,
        numTurns: result.numTurns ?? 1,
        ...result,
      };
    },
  };
  return { engine, calls };
}

describe("summarizeSession", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-summarize-test-"));
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

  function seedTranscript(engineSessionId: string, messages: Array<{ role: "user" | "assistant"; content: string }>) {
    const projectDir = path.join(tmpHome, ".claude", "projects", "-p");
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = messages.map((m) => JSON.stringify({ type: m.role, message: { content: m.content } })).join("\n");
    fs.writeFileSync(path.join(projectDir, `${engineSessionId}.jsonl`), lines);
  }

  test("throws when session has no engineSessionId", async () => {
    const { engine } = makeStubEngine();
    await expect(
      summarizeSession({ session: fakeSession({ engineSessionId: null }), engine, cwd: tmpHome }),
    ).rejects.toThrow(/no engineSessionId/);
  });

  test("throws when transcript file is missing", async () => {
    const { engine } = makeStubEngine();
    await expect(
      summarizeSession({ session: fakeSession({ engineSessionId: "missing" }), engine, cwd: tmpHome }),
    ).rejects.toThrow(/no transcript found/);
  });

  test("inlines transcript in prompt and calls engine WITHOUT resumeSessionId", async () => {
    seedTranscript("eng-1", [
      { role: "user", content: "Build the v2 PRD" },
      { role: "assistant", content: "Locked: SPA, single-user, Docker Compose." },
    ]);
    const { engine, calls } = makeStubEngine();
    await summarizeSession({ session: fakeSession(), engine, cwd: tmpHome });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    // Critical Phase 3.1 invariant: no --resume. The summarizer must NOT
    // rehydrate the prior conversation's persona; the transcript is inlined
    // as text in the prompt instead.
    expect(call.resumeSessionId).toBeUndefined();
    // Transcript content must appear inline in the prompt
    expect(call.prompt).toContain("Build the v2 PRD");
    expect(call.prompt).toContain("Locked: SPA, single-user, Docker Compose.");
    // Prompt must include the structured-summary directive
    expect(call.prompt).toContain("# Prior conversation summary");
    expect(call.prompt).toContain("## Goals");
    expect(call.prompt).toContain("## Decisions made");
    // Prompt must explicitly tell the model not to continue in-persona
    expect(call.prompt).toMatch(/do NOT continue any task|do NOT respond in the persona/);
  });

  test("returns the engine's summary text (trimmed)", async () => {
    seedTranscript("eng-1", [{ role: "user", content: "hi" }]);
    const { engine } = makeStubEngine({ result: "  # Prior conversation summary\n## Goals\n- greet\n  " });
    const out = await summarizeSession({ session: fakeSession(), engine, cwd: tmpHome });
    expect(out).toBe("# Prior conversation summary\n## Goals\n- greet");
  });

  test("throws on engine error or empty result", async () => {
    seedTranscript("eng-1", [{ role: "user", content: "hi" }]);
    const errEngine = makeStubEngine({ result: "", error: "boom" });
    await expect(summarizeSession({ session: fakeSession(), engine: errEngine.engine, cwd: tmpHome })).rejects.toThrow(/engine error/);
    const emptyEngine = makeStubEngine({ result: "   " });
    await expect(summarizeSession({ session: fakeSession(), engine: emptyEngine.engine, cwd: tmpHome })).rejects.toThrow(/empty result/);
  });

  test("uses configured model (default sonnet)", async () => {
    seedTranscript("eng-1", [{ role: "user", content: "hi" }]);
    const { engine, calls } = makeStubEngine();
    await summarizeSession({ session: fakeSession(), engine, cwd: tmpHome });
    expect(calls[0].model).toBe("sonnet");
    await summarizeSession({ session: fakeSession(), engine, cwd: tmpHome, model: "haiku" });
    expect(calls[1].model).toBe("haiku");
  });

  test("truncates very long transcripts and notes it in the prompt", async () => {
    // Build a transcript whose total chars far exceed MAX_INLINE_CHARS (400K).
    // Each big block ~10K chars, repeat 60× = 600K chars total.
    const big = "x".repeat(10_000);
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}: ${big}`,
    }));
    seedTranscript("eng-1", messages);
    const { engine, calls } = makeStubEngine();
    await summarizeSession({ session: fakeSession(), engine, cwd: tmpHome });
    expect(calls[0].prompt).toContain("Note: the conversation was longer than the summarizer's input budget");
    // Most-recent turns should be present
    expect(calls[0].prompt).toContain("turn 59:");
    // Earliest turns should be dropped
    expect(calls[0].prompt).not.toContain("turn 0:");
  });
});
