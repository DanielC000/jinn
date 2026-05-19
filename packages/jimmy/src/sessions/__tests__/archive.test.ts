import { describe, test, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";

/**
 * Smoke tests for the auto-split archive workflow. These exercise the
 * SQL transaction shape directly against an in-memory DB so we don't depend
 * on module-level initDb() state.
 *
 * archiveSession() in archive.ts uses initDb() which binds to the real
 * ~/.jinn/sessions/registry.db — full integration tests against the function
 * itself need an initDb-injection refactor. For now we verify (a) the schema
 * migration adds the 5 columns and (b) the SQL the function executes
 * produces the expected end-state.
 */
function setupDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      engine_session_id TEXT,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      employee TEXT,
      model TEXT,
      status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error TEXT
    )
  `);
  migrateSessionsSchema(db);
  return db;
}

function insertSession(db: Database.Database, id: string, opts: Partial<{ parentId: string; status: string }> = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, session_key, status, created_at, last_activity, parent_session_id)
     VALUES (?, 'claude', 'web', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `web:${id}`, `web:${id}`, opts.status ?? "idle", now, now, opts.parentId ?? null);
}

describe("auto-split archive", () => {
  test("migration adds all 5 auto-split columns", () => {
    const db = setupDb();
    const cols = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has("archived_at")).toBe(true);
    expect(cols.has("archived_to")).toBe(true);
    expect(cols.has("archived_from")).toBe(true);
    expect(cols.has("summary_prompt")).toBe(true);
    expect(cols.has("auto_split_disabled")).toBe(true);
  });

  test("archive transaction marks old archived, links new back, re-parents active children only", () => {
    const db = setupDb();
    insertSession(db, "old");
    insertSession(db, "child-active", { parentId: "old" });
    insertSession(db, "child-error", { parentId: "old", status: "error" });
    insertSession(db, "child-archived", { parentId: "old", status: "archived" });

    const oldId = "old";
    const newId = "new";
    const now = new Date().toISOString();
    const summary = "Prior conversation: built v1 PRD, locked Docker Compose stack, parked v2.";

    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO sessions (id, engine, source, source_ref, session_key, status, created_at, last_activity, archived_from, summary_prompt)
         VALUES (?, 'claude', 'web', ?, ?, 'idle', ?, ?, ?, ?)`,
      ).run(newId, `web:${newId}`, `web:${newId}::archive`, now, now, oldId, summary);
      db.prepare(`UPDATE sessions SET status='archived', archived_at=?, archived_to=?, last_activity=? WHERE id=?`).run(now, newId, now, oldId);
      const r = db.prepare(`UPDATE sessions SET parent_session_id=? WHERE parent_session_id=? AND status NOT IN ('archived', 'error')`).run(newId, oldId);
      return r.changes;
    });
    const reparented = txn() as number;

    const oldRow = db.prepare(`SELECT status, archived_at, archived_to FROM sessions WHERE id=?`).get(oldId) as Record<string, unknown>;
    expect(oldRow.status).toBe("archived");
    expect(typeof oldRow.archived_at).toBe("string");
    expect(oldRow.archived_to).toBe(newId);

    const newRow = db.prepare(`SELECT status, archived_from, summary_prompt FROM sessions WHERE id=?`).get(newId) as Record<string, unknown>;
    expect(newRow.status).toBe("idle");
    expect(newRow.archived_from).toBe(oldId);
    expect(newRow.summary_prompt).toBe(summary);

    expect(reparented).toBe(1);
    const activeChild = db.prepare(`SELECT parent_session_id FROM sessions WHERE id=?`).get("child-active") as { parent_session_id: string };
    expect(activeChild.parent_session_id).toBe(newId);
    const errorChild = db.prepare(`SELECT parent_session_id FROM sessions WHERE id=?`).get("child-error") as { parent_session_id: string };
    expect(errorChild.parent_session_id).toBe(oldId);
    const archivedChild = db.prepare(`SELECT parent_session_id FROM sessions WHERE id=?`).get("child-archived") as { parent_session_id: string };
    expect(archivedChild.parent_session_id).toBe(oldId);
  });
});
