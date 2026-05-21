import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Engine, EngineRunOpts, EngineResult } from "../../shared/types.js";

/**
 * Stub engine that records calls and returns a canned result so tests can assert
 * what the task summariser asked for (prompt shape, model, sessionId).
 */
function makeStubEngine(result: Partial<EngineResult> = {}): { engine: Engine; calls: EngineRunOpts[] } {
  const calls: EngineRunOpts[] = [];
  const engine: Engine = {
    name: "claude",
    async run(opts: EngineRunOpts): Promise<EngineResult> {
      calls.push(opts);
      return {
        sessionId: opts.sessionId ?? "eng-out",
        result: result.result ?? "# Task Retrospective\n\n## What we set out to do\n- ship the thing\n",
        cost: result.cost ?? 0.001,
        durationMs: result.durationMs ?? 100,
        numTurns: result.numTurns ?? 1,
        ...result,
      };
    },
  };
  return { engine, calls };
}

async function withFreshOrg() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-summarize-task-"));
  process.env.JINN_HOME = tmp;
  vi.resetModules();
  const registry = await import("../registry.js");
  const migration = await import("../migrations/001-organisations.js");
  const summarise = await import("../summarize-task.js");
  registry.initDb();
  const result = migration.runOrganisationsMigration();
  return { tmp, registry, summarise, orgId: result.organisationId! };
}

describe("summarizeTask", () => {
  const originalHome = process.env.JINN_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = originalHome;
  });

  test("skips silently when the task has no bound sessions", async () => {
    const { registry, summarise, orgId } = await withFreshOrg();
    const t = registry.createTask({ organisationId: orgId, title: "Ghost" });
    const { engine, calls } = makeStubEngine();

    const out = await summarise.summarizeTask({ task: t, engine, cwd: "/tmp", model: "sonnet" });
    expect(out).toBe("");
    expect(calls).toHaveLength(0);
    // task.summary stays null when nothing happened.
    expect(registry.getTask(t.id)?.summary).toBeNull();
  });

  test("renders an interleaved transcript across every bound session and stores the summary", async () => {
    const { registry, summarise, orgId } = await withFreshOrg();
    const t = registry.createTask({ organisationId: orgId, title: "Ship feature X" });
    const sA = registry.createSession({
      engine: "claude", source: "web", sourceRef: "web:a",
      organisationId: orgId, taskId: t.id, employee: "lead-a",
    });
    const sB = registry.createSession({
      engine: "claude", source: "web", sourceRef: "web:b",
      organisationId: orgId, taskId: t.id, employee: "eng-b",
    });
    // Interleave: lead asks → eng answers → lead reviews → eng iterates.
    registry.insertMessage(sA.id, "user", "Triage this bug");
    registry.insertMessage(sB.id, "user", "Lead asked you to investigate Bug-42");
    registry.insertMessage(sB.id, "assistant", "Found the off-by-one in pagination");
    registry.insertMessage(sA.id, "assistant", "Filed PR #15");

    const { engine, calls } = makeStubEngine();
    const summary = await summarise.summarizeTask({ task: t, engine, cwd: "/tmp", model: "sonnet" });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("sonnet");
    // Prompt should mention the task title and both employees' content so the
    // summariser sees the whole story, not one session in isolation.
    expect(calls[0].prompt).toContain("Ship feature X");
    expect(calls[0].prompt).toContain("Found the off-by-one in pagination");
    expect(calls[0].prompt).toContain("Filed PR #15");
    // Must NOT pass resumeSessionId — clean Sonnet pass, no persona bleed.
    expect((calls[0] as EngineRunOpts & { resumeSessionId?: string }).resumeSessionId).toBeUndefined();

    expect(summary).toContain("Task Retrospective");
    const stored = registry.getTask(t.id);
    expect(stored?.summary).toContain("Task Retrospective");
    expect(stored?.summaryGeneratedAt).toBeTruthy();
  });

  test("throws when the engine returns an error", async () => {
    const { registry, summarise, orgId } = await withFreshOrg();
    const t = registry.createTask({ organisationId: orgId, title: "X" });
    const s = registry.createSession({
      engine: "claude", source: "web", sourceRef: "web:x",
      organisationId: orgId, taskId: t.id, employee: "e",
    });
    registry.insertMessage(s.id, "assistant", "anything");

    const { engine } = makeStubEngine({ result: undefined, error: "boom" } as Partial<EngineResult>);
    await expect(
      summarise.summarizeTask({ task: t, engine, cwd: "/tmp", model: "sonnet" }),
    ).rejects.toThrow(/engine error/);
    // Failed summarisation must NOT persist a partial/empty summary.
    expect(registry.getTask(t.id)?.summary).toBeNull();
  });

  test("throws when the engine returns an empty result", async () => {
    const { registry, summarise, orgId } = await withFreshOrg();
    const t = registry.createTask({ organisationId: orgId, title: "Y" });
    const s = registry.createSession({
      engine: "claude", source: "web", sourceRef: "web:y",
      organisationId: orgId, taskId: t.id, employee: "e",
    });
    registry.insertMessage(s.id, "assistant", "anything");

    const { engine } = makeStubEngine({ result: "   " });
    await expect(
      summarise.summarizeTask({ task: t, engine, cwd: "/tmp", model: "sonnet" }),
    ).rejects.toThrow(/empty result/);
  });
});
