import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-resume-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

function insertSession(
  db: import("better-sqlite3").Database,
  id: string,
  fields: { status?: string; lastActivity?: string } = {},
) {
  const ts = fields.lastActivity ?? "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, session_key, status, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, ?, ?, ?, ?)`,
  ).run(id, `web:${id}`, `web:${id}`, fields.status ?? "idle", ts, ts);
}

function insertQueueItem(
  db: import("better-sqlite3").Database,
  id: string,
  sessionId: string,
  status: "pending" | "running" | "completed" | "cancelled" = "pending",
) {
  db.prepare(
    `INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at)
     VALUES (?, ?, ?, 'hello', ?, 0, ?)`,
  ).run(id, sessionId, `web:${sessionId}`, status, "2026-01-01T00:00:00.000Z");
}

beforeAll(async () => {
  reg = await import("../registry.js");
  const db = reg.initDb();
  // Wipe in case of prior runs (the tmp dir is fresh but be defensive).
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM sessions").run();

  // Scenario shape:
  //   s-idle-with-pending: status='idle', has 3 pending queue items     → markSessions... marks interrupted
  //   s-running-with-pending: status='running', has 2 pending items     → recoverStaleSessions marks interrupted (separate step)
  //   s-archived-with-pending: status='archived', has 1 pending item    → markSessions... must NOT touch (archived guard)
  //   s-already-interrupted: status='interrupted', has 1 pending item   → markSessions... must NOT re-write last_error
  //   s-idle-no-pending: status='idle', no pending items                → markSessions... must NOT touch
  //   s-idle-with-completed: status='idle', has 1 completed item        → markSessions... must NOT touch
  insertSession(db, "s-idle-with-pending", { status: "idle" });
  insertQueueItem(db, "q1", "s-idle-with-pending");
  insertQueueItem(db, "q2", "s-idle-with-pending");
  insertQueueItem(db, "q3", "s-idle-with-pending");

  insertSession(db, "s-running-with-pending", { status: "running" });
  insertQueueItem(db, "q4", "s-running-with-pending");
  insertQueueItem(db, "q5", "s-running-with-pending");

  insertSession(db, "s-archived-with-pending", { status: "archived" });
  insertQueueItem(db, "q6", "s-archived-with-pending");

  insertSession(db, "s-already-interrupted", { status: "interrupted" });
  insertQueueItem(db, "q7", "s-already-interrupted");

  insertSession(db, "s-idle-no-pending", { status: "idle" });

  insertSession(db, "s-idle-with-completed", { status: "idle" });
  insertQueueItem(db, "q8", "s-idle-with-completed", "completed");
});

describe("markSessionsWithPendingQueueAsInterrupted", () => {
  it("flips idle sessions with pending queue items to interrupted", () => {
    const changed = reg.markSessionsWithPendingQueueAsInterrupted();
    // Should mark s-idle-with-pending and s-running-with-pending. The latter
    // is included because the function only excludes 'archived' and
    // 'interrupted' — 'running' on boot is a stale state that
    // recoverStaleSessions would also catch.
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(reg.getSession("s-idle-with-pending")?.status).toBe("interrupted");
  });

  it("does NOT touch archived sessions even with pending items", () => {
    expect(reg.getSession("s-archived-with-pending")?.status).toBe("archived");
  });

  it("does NOT touch sessions already interrupted (avoids stomping lastError)", () => {
    // Set a known lastError on the already-interrupted session and re-run.
    reg.updateSession("s-already-interrupted", { lastError: "Original cause" });
    reg.markSessionsWithPendingQueueAsInterrupted();
    const s = reg.getSession("s-already-interrupted");
    expect(s?.status).toBe("interrupted");
    expect(s?.lastError).toBe("Original cause");
  });

  it("does NOT touch sessions with no pending items", () => {
    expect(reg.getSession("s-idle-no-pending")?.status).toBe("idle");
    expect(reg.getSession("s-idle-with-completed")?.status).toBe("idle");
  });
});

describe("countPendingQueueItemsForSession", () => {
  it("counts only status='pending' rows for the given session", () => {
    expect(reg.countPendingQueueItemsForSession("s-idle-with-pending")).toBe(3);
    expect(reg.countPendingQueueItemsForSession("s-idle-no-pending")).toBe(0);
    expect(reg.countPendingQueueItemsForSession("s-idle-with-completed")).toBe(0);
  });

  it("returns 0 for unknown session IDs", () => {
    expect(reg.countPendingQueueItemsForSession("does-not-exist")).toBe(0);
  });
});

describe("listPendingQueueItemsForSession", () => {
  it("returns only pending items for the given session", () => {
    const items = reg.listPendingQueueItemsForSession("s-idle-with-pending");
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id).sort()).toEqual(["q1", "q2", "q3"]);
  });

  it("excludes completed items", () => {
    const items = reg.listPendingQueueItemsForSession("s-idle-with-completed");
    expect(items).toHaveLength(0);
  });
});

describe("resetRunningQueueItemsForSession", () => {
  it("flips status='running' rows back to pending for the given session", () => {
    const db = reg.initDb();
    // Create a fresh session with a running queue item
    insertSession(db, "s-reset-test", { status: "running" });
    insertQueueItem(db, "qreset1", "s-reset-test", "running");
    insertQueueItem(db, "qreset2", "s-reset-test", "pending");

    const changed = reg.resetRunningQueueItemsForSession("s-reset-test");
    expect(changed).toBe(1);
    expect(reg.countPendingQueueItemsForSession("s-reset-test")).toBe(2);
  });
});
