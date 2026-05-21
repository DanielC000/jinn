import { describe, expect, test } from "vitest";
import { buildContext, buildMinimalContext, type TaskContext } from "../context.js";
import type { Task } from "../../shared/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    organisationId: "org-1",
    title: "Ship the thing",
    description: "",
    priority: "med",
    status: "in-progress",
    leadSessionId: null,
    supersedesTaskId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    kind: "standard",
    ...overrides,
  };
}

describe("buildContext task block", () => {
  test("omits the Current task section when no taskContext is passed", () => {
    const out = buildContext({
      source: "web",
      channel: "test",
      user: "u",
      sessionId: "sess-1",
    });
    expect(out).not.toContain("## Current task");
  });

  test("emits a Current task block with id, title, and status when task-bound", () => {
    const taskContext: TaskContext = { task: makeTask() };
    const out = buildContext({
      source: "web",
      channel: "test",
      user: "u",
      sessionId: "sess-1",
      taskContext,
    });
    expect(out).toContain("## Current task");
    expect(out).toContain("task-1");
    expect(out).toContain("Ship the thing");
    expect(out).toContain("in-progress");
    expect(out).toContain("Per-task reuse");
  });

  test("includes Supersedes line when the task replaces another", () => {
    const prev = makeTask({ id: "task-0", title: "First attempt", status: "done" });
    const current = makeTask({ id: "task-1", supersedesTaskId: prev.id });
    const out = buildContext({
      source: "web",
      channel: "test",
      user: "u",
      sessionId: "sess-1",
      taskContext: { task: current, supersedes: prev },
    });
    expect(out).toMatch(/Supersedes:.*First attempt.*task-0.*done/);
  });

  test("includes Superseded-by list when follow-ups have been filed", () => {
    const current = makeTask();
    const a = makeTask({ id: "task-2", title: "Follow-up A", status: "todo" });
    const b = makeTask({ id: "task-3", title: "Follow-up B", status: "in-progress" });
    const out = buildContext({
      source: "web",
      channel: "test",
      user: "u",
      sessionId: "sess-1",
      taskContext: { task: current, supersededBy: [a, b] },
    });
    expect(out).toMatch(/Superseded by:.*Follow-up A.*Follow-up B/);
  });

  test("spike tasks get the SPIKE marker and the explore-then-decide guidance", () => {
    const out = buildContext({
      source: "web", channel: "x", user: "u", sessionId: "s",
      taskContext: { task: makeTask({ kind: "spike", title: "Why is X slow?" }) },
    });
    expect(out).toMatch(/Kind:\s*\*\*SPIKE\*\*/);
    expect(out).toContain("time-boxed exploration");
    expect(out).toContain("This is a spike");
    expect(out).toContain("Don't ship code or documents");
  });

  test("standard tasks omit spike-specific guidance", () => {
    const out = buildContext({
      source: "web", channel: "x", user: "u", sessionId: "s",
      taskContext: { task: makeTask({ kind: "standard" }) },
    });
    expect(out).not.toContain("SPIKE");
    expect(out).not.toContain("This is a spike");
  });

  test("priority line only appears when non-default", () => {
    const high = buildContext({
      source: "web", channel: "x", user: "u", sessionId: "s",
      taskContext: { task: makeTask({ priority: "high" }) },
    });
    expect(high).toContain("Priority: high");

    const med = buildContext({
      source: "web", channel: "x", user: "u", sessionId: "s",
      taskContext: { task: makeTask({ priority: "med" }) },
    });
    expect(med).not.toContain("Priority: med");
  });
});

describe("buildMinimalContext task block", () => {
  test("warm sessions also see the Current task block — closes the per-turn-protocol gap from the v0.14.0 review", () => {
    const out = buildMinimalContext({
      source: "web",
      channel: "test",
      user: "u",
      sessionId: "sess-1",
      taskContext: { task: makeTask() },
    });
    expect(out).toContain("## Current task");
    expect(out).toContain("Per-task reuse");
  });

  test("untracked warm sessions stay minimal (no Current task block)", () => {
    const out = buildMinimalContext({
      source: "web",
      channel: "test",
      user: "u",
      sessionId: "sess-1",
    });
    expect(out).not.toContain("## Current task");
  });
});
