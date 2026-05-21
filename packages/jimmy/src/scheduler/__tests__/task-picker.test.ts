import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

async function withFreshOrg() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-p6-"));
  process.env.JINN_HOME = tmp;
  vi.resetModules();
  const registry = await import("../../sessions/registry.js");
  const migration = await import("../../sessions/migrations/001-organisations.js");
  registry.initDb();
  const result = migration.runOrganisationsMigration();
  return { tmp, registry, orgId: result.organisationId! };
}

describe("Phase 6 task picker", () => {
  const originalHome = process.env.JINN_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = originalHome;
  });

  test("dispatches To Do tasks up to the WIP cap (default 3)", async () => {
    const { registry, orgId } = await withFreshOrg();
    // Create 5 To Do tasks
    for (const t of ["A", "B", "C", "D", "E"]) {
      registry.createTask({ organisationId: orgId, title: t, status: "todo" });
    }
    const { pickOnce } = await import("../task-picker.js");
    const dispatched: string[] = [];
    pickOnce({ emit: (event, payload) => {
      if (event === "task:dispatched") dispatched.push((payload as { taskId: string }).taskId);
    } });

    const inProgress = registry.listTasks({ organisationId: orgId, status: "in-progress" });
    expect(inProgress).toHaveLength(3); // default cap = 3
    expect(dispatched).toHaveLength(3);

    // Each dispatched task should have a lead_session_id set.
    for (const t of inProgress) {
      expect(t.leadSessionId).toBeTruthy();
      const sess = registry.getSession(t.leadSessionId!);
      expect(sess?.employee).toBe("jinn"); // Default's default lead
      expect(sess?.taskId).toBe(t.id);
    }
  });

  test("a task in Waiting does not consume a WIP slot", async () => {
    const { registry, orgId } = await withFreshOrg();
    // Fill running slots
    for (const _ of [1, 2]) {
      const t = registry.createTask({ organisationId: orgId, title: "running", status: "in-progress" });
      void t;
    }
    // One parked
    registry.createTask({ organisationId: orgId, title: "parked", status: "waiting" });
    // Two more to dispatch
    registry.createTask({ organisationId: orgId, title: "next1", status: "todo" });
    registry.createTask({ organisationId: orgId, title: "next2", status: "todo" });

    const { pickOnce } = await import("../task-picker.js");
    pickOnce();

    // Default cap = 3, running was 2, so one more should dispatch (now 3 running, 1 still todo).
    expect(registry.listTasks({ organisationId: orgId, status: "in-progress" }).length).toBe(3);
    expect(registry.listTasks({ organisationId: orgId, status: "waiting" }).length).toBe(1);
    expect(registry.listTasks({ organisationId: orgId, status: "todo" }).length).toBe(1);
  });

  test("dispatch is skipped when no leadEmployeeId is set", async () => {
    const { registry, orgId } = await withFreshOrg();
    registry.updateOrganisation(orgId, { leadEmployeeId: null });
    registry.createTask({ organisationId: orgId, title: "X", status: "todo" });
    const { pickOnce } = await import("../task-picker.js");
    pickOnce();
    expect(registry.listTasks({ organisationId: orgId, status: "in-progress" }).length).toBe(0);
  });

  test("reconciler marks a task stalled when its lead session enters error", async () => {
    const { registry, orgId } = await withFreshOrg();
    const task = registry.createTask({ organisationId: orgId, title: "T", status: "todo" });
    const { pickOnce } = await import("../task-picker.js");
    pickOnce();
    const afterDispatch = registry.getTask(task.id)!;
    expect(afterDispatch.status).toBe("in-progress");
    expect(afterDispatch.leadSessionId).toBeTruthy();

    // Wedge the lead by flipping it to error.
    registry.updateSession(afterDispatch.leadSessionId!, { status: "error", lastError: "boom" });

    const { reconcileOnce } = await import("../task-reconciler.js");
    const events: Array<{ event: string; payload: unknown }> = [];
    reconcileOnce({ emit: (event, payload) => events.push({ event, payload }) });

    expect(registry.getTask(task.id)?.status).toBe("stalled");
    expect(events.some((e) => e.event === "task:stalled")).toBe(true);
  });
});
