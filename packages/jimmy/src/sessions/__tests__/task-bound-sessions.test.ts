import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Phase 5 smoke tests:
 *   - findChildSessionByEmployeeAndTask returns the same row for repeat lookups
 *   - createSession with taskId+organisationId populates both columns
 *   - rowToSession surfaces the new FK fields back to the caller
 */

async function withFreshOrg() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-p5-"));
  process.env.JINN_HOME = tmp;
  vi.resetModules();
  const registry = await import("../registry.js");
  const migration = await import("../migrations/001-organisations.js");
  registry.initDb();
  const result = migration.runOrganisationsMigration();
  return { tmp, registry, orgId: result.organisationId! };
}

describe("Phase 5 task-bound sessions", () => {
  const originalHome = process.env.JINN_HOME;
  afterEach(() => {
    if (originalHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = originalHome;
  });

  test("createSession persists organisationId, taskId, employeeId", async () => {
    const { registry, orgId } = await withFreshOrg();
    const task = registry.createTask({ organisationId: orgId, title: "Build X" });
    const session = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:1",
      employee: "lead-alpha",
      organisationId: orgId,
      taskId: task.id,
      employeeId: "emp-1",
    });
    const fetched = registry.getSession(session.id);
    expect(fetched?.organisationId).toBe(orgId);
    expect(fetched?.taskId).toBe(task.id);
    expect(fetched?.employeeId).toBe("emp-1");
  });

  test("findChildSessionByEmployeeAndTask returns existing live session", async () => {
    const { registry, orgId } = await withFreshOrg();
    const task = registry.createTask({ organisationId: orgId, title: "T" });
    const first = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:a",
      employee: "lead-alpha",
      organisationId: orgId,
      taskId: task.id,
    });
    const found = registry.findChildSessionByEmployeeAndTask("lead-alpha", task.id);
    expect(found?.id).toBe(first.id);
  });

  test("archived sessions don't count for per-task uniqueness", async () => {
    const { registry, orgId } = await withFreshOrg();
    const task = registry.createTask({ organisationId: orgId, title: "T" });
    const first = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:a",
      employee: "lead-alpha",
      organisationId: orgId,
      taskId: task.id,
    });
    registry.updateSession(first.id, { status: "archived" });
    expect(registry.findChildSessionByEmployeeAndTask("lead-alpha", task.id)).toBeUndefined();
  });

  test("different tasks produce different sessions for the same employee", async () => {
    const { registry, orgId } = await withFreshOrg();
    const tA = registry.createTask({ organisationId: orgId, title: "A" });
    const tB = registry.createTask({ organisationId: orgId, title: "B" });
    const a = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:a",
      employee: "backend-bravo",
      organisationId: orgId,
      taskId: tA.id,
    });
    const b = registry.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:b",
      employee: "backend-bravo",
      organisationId: orgId,
      taskId: tB.id,
    });
    expect(a.id).not.toBe(b.id);
    expect(registry.findChildSessionByEmployeeAndTask("backend-bravo", tA.id)?.id).toBe(a.id);
    expect(registry.findChildSessionByEmployeeAndTask("backend-bravo", tB.id)?.id).toBe(b.id);
  });
});
