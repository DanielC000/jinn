import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";
import { getTranscriptByteEstimate, isAutoSplitDue, resolveAutoSplitConfig } from "../archive.js";
import type { Employee, Session } from "../../shared/types.js";

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

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    engine: "claude",
    engineSessionId: null,
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

describe("isAutoSplitDue", () => {
  test("messages trigger fires when messageCount crosses triggerMessages", () => {
    expect(isAutoSplitDue({ session: fakeSession(), messageCount: 100 })).toEqual({ due: true, trigger: "messages" });
    expect(isAutoSplitDue({ session: fakeSession(), messageCount: 99 })).toEqual({ due: false });
  });

  test("returns due:false when session is archived", () => {
    expect(isAutoSplitDue({ session: fakeSession({ status: "archived" }), messageCount: 500 })).toEqual({ due: false });
  });

  test("returns due:false when autoSplitDisabled", () => {
    expect(isAutoSplitDue({ session: fakeSession({ autoSplitDisabled: true }), messageCount: 500 })).toEqual({ due: false });
  });

  test("returns due:false when feature disabled in config", () => {
    expect(
      isAutoSplitDue({
        session: fakeSession(),
        messageCount: 500,
        config: { sessions: { autoSplit: { enabled: false } } } as any,
      }),
    ).toEqual({ due: false });
  });

  test("returns due:false when mode is 'disabled'", () => {
    expect(
      isAutoSplitDue({
        session: fakeSession(),
        messageCount: 500,
        config: { sessions: { autoSplit: { mode: "disabled" } } } as any,
      }),
    ).toEqual({ due: false });
  });

  test("respects custom triggerMessages from config", () => {
    expect(
      isAutoSplitDue({
        session: fakeSession(),
        messageCount: 75,
        config: { sessions: { autoSplit: { triggerMessages: 75 } } } as any,
      }),
    ).toEqual({ due: true, trigger: "messages" });
  });

  test("rank=executive uses built-in lower threshold of 60", () => {
    const exec: Employee = {
      name: "sasha", displayName: "Sasha", department: "ops", rank: "executive",
      engine: "claude", model: "sonnet", persona: "",
    };
    // At 60 messages an executive should be due; an unranked (employee-rank) session
    // sitting at 60 should not (default 100 applies).
    expect(isAutoSplitDue({ session: fakeSession(), messageCount: 60, employee: exec })).toEqual({ due: true, trigger: "messages" });
    expect(isAutoSplitDue({ session: fakeSession(), messageCount: 60 })).toEqual({ due: false });
  });

  test("rank=senior uses built-in threshold of 80", () => {
    const sen: Employee = {
      name: "vera", displayName: "Vera", department: "qa", rank: "senior",
      engine: "claude", model: "sonnet", persona: "",
    };
    expect(isAutoSplitDue({ session: fakeSession(), messageCount: 80, employee: sen })).toEqual({ due: true, trigger: "messages" });
    expect(isAutoSplitDue({ session: fakeSession(), messageCount: 79, employee: sen })).toEqual({ due: false });
  });

  test("per-rank operator override beats built-in rank default", () => {
    const exec: Employee = {
      name: "sasha", displayName: "Sasha", department: "ops", rank: "executive",
      engine: "claude", model: "sonnet", persona: "",
    };
    // Operator dialed exec back up to 150 — should not fire at 60.
    expect(
      isAutoSplitDue({
        session: fakeSession(),
        messageCount: 60,
        employee: exec,
        config: { sessions: { autoSplit: { perRank: { executive: { triggerMessages: 150 } } } } } as any,
      }),
    ).toEqual({ due: false });
  });

  test("per-rank operator override beats global config", () => {
    const exec: Employee = {
      name: "sasha", displayName: "Sasha", department: "ops", rank: "executive",
      engine: "claude", model: "sonnet", persona: "",
    };
    // Global set to 200, per-rank override at 40 — exec at 40 should fire.
    expect(
      isAutoSplitDue({
        session: fakeSession(),
        messageCount: 40,
        employee: exec,
        config: { sessions: { autoSplit: { triggerMessages: 200, perRank: { executive: { triggerMessages: 40 } } } } } as any,
      }),
    ).toEqual({ due: true, trigger: "messages" });
  });
});

describe("resolveAutoSplitConfig", () => {
  test("returns AUTO_SPLIT_DEFAULTS when no config and no employee", () => {
    const cfg = resolveAutoSplitConfig(undefined, undefined);
    expect(cfg.triggerMessages).toBe(100);
    expect(cfg.mode).toBe("prompt");
  });

  test("manager rank applies built-in 60-message default", () => {
    const mgr: Employee = {
      name: "aaron", displayName: "Aaron", department: "eng", rank: "manager",
      engine: "claude", model: "sonnet", persona: "",
    };
    expect(resolveAutoSplitConfig(undefined, mgr).triggerMessages).toBe(60);
  });

  test("global config overrides built-in rank default", () => {
    const mgr: Employee = {
      name: "aaron", displayName: "Aaron", department: "eng", rank: "manager",
      engine: "claude", model: "sonnet", persona: "",
    };
    const cfg = resolveAutoSplitConfig(
      { sessions: { autoSplit: { triggerMessages: 200 } } } as any,
      mgr,
    );
    expect(cfg.triggerMessages).toBe(200);
  });

  test("per-rank wins over global", () => {
    const mgr: Employee = {
      name: "aaron", displayName: "Aaron", department: "eng", rank: "manager",
      engine: "claude", model: "sonnet", persona: "",
    };
    const cfg = resolveAutoSplitConfig(
      { sessions: { autoSplit: { triggerMessages: 200, perRank: { manager: { triggerMessages: 50 } } } } } as any,
      mgr,
    );
    expect(cfg.triggerMessages).toBe(50);
  });

  test("perRank table is not leaked onto the resolved config", () => {
    const cfg = resolveAutoSplitConfig(
      { sessions: { autoSplit: { perRank: { manager: { triggerMessages: 50 } } } } } as any,
      undefined,
    );
    expect((cfg as any).perRank).toBeUndefined();
  });
});

describe("getTranscriptByteEstimate", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-archive-test-"));
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

  test("returns 0 when no engineSessionId", () => {
    expect(getTranscriptByteEstimate(fakeSession())).toBe(0);
  });

  test("returns 0 for non-claude engines", () => {
    expect(getTranscriptByteEstimate(fakeSession({ engine: "codex", engineSessionId: "x" }))).toBe(0);
  });

  test("returns 0 when projects dir doesn't exist", () => {
    expect(getTranscriptByteEstimate(fakeSession({ engineSessionId: "missing" }))).toBe(0);
  });

  test("finds the jsonl across project dirs and returns its byte size", () => {
    const engineSessionId = "abc-123";
    const projectDir = path.join(tmpHome, ".claude", "projects", "-some-cwd-key");
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonl = path.join(projectDir, `${engineSessionId}.jsonl`);
    const payload = "x".repeat(40_000);
    fs.writeFileSync(jsonl, payload);
    expect(getTranscriptByteEstimate(fakeSession({ engineSessionId }))).toBe(40_000);
  });

  test("byte-based trigger fires through isAutoSplitDue at the configured threshold with tokensEstimate", () => {
    const engineSessionId = "byte-trig";
    const projectDir = path.join(tmpHome, ".claude", "projects", "-some-cwd");
    fs.mkdirSync(projectDir, { recursive: true });
    // 400K bytes → ~100K-token estimate at chars/4, well past the 80K default.
    fs.writeFileSync(path.join(projectDir, `${engineSessionId}.jsonl`), "x".repeat(400_000));
    const session = fakeSession({ engineSessionId });
    const result = isAutoSplitDue({ session, messageCount: 0 });
    expect(result.due).toBe(true);
    expect(result.trigger).toBe("bytes");
    expect(result.tokensEstimate).toBe(100_000);
  });

  test("byte-based trigger does NOT fire when below threshold", () => {
    const engineSessionId = "byte-below";
    const projectDir = path.join(tmpHome, ".claude", "projects", "-x");
    fs.mkdirSync(projectDir, { recursive: true });
    // 200K bytes → ~50K tokens, below the 80K default.
    fs.writeFileSync(path.join(projectDir, `${engineSessionId}.jsonl`), "x".repeat(200_000));
    const session = fakeSession({ engineSessionId });
    expect(isAutoSplitDue({ session, messageCount: 0 })).toEqual({ due: false });
  });

  test("messages trigger wins over bytes trigger when both would fire", () => {
    const engineSessionId = "both-trig";
    const projectDir = path.join(tmpHome, ".claude", "projects", "-both");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${engineSessionId}.jsonl`), "x".repeat(400_000));
    const session = fakeSession({ engineSessionId });
    // messageCount above triggerMessages should short-circuit to messages trigger
    // (cheaper than the disk hit) — verify we don't accidentally upgrade to bytes.
    const result = isAutoSplitDue({ session, messageCount: 150 });
    expect(result).toEqual({ due: true, trigger: "messages" });
  });
});
