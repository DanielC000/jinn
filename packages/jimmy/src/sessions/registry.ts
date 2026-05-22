import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SESSIONS_DB } from '../shared/paths.js';
import type { CronJob, JsonObject, Organisation, ReplyContext, Session, Task, TaskKind, TaskPriority, TaskStatus } from '../shared/types.js';

let db: Database.Database;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  connector TEXT,
  session_key TEXT,
  reply_context TEXT,
  message_id TEXT,
  transport_meta TEXT,
  employee TEXT,
  model TEXT,
  title TEXT,
  parent_session_id TEXT,
  status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT
)`;

const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp)
`;

const CREATE_SESSION_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity)
`;

// Backs `ORDER BY last_activity DESC` in the session list (was a full scan + sort).
const CREATE_LAST_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity DESC)
`;

// Backs the children lookup (was a full-table deserialization + JS filter).
const CREATE_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)
`;

const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  created_at TEXT NOT NULL
)
`;

// ── Project-scoped task-bound workflow (Phase 1) ─────────────────────
//
// Schema is added with nullable FKs to every existing table that gains one,
// so legacy rows survive without backfill. Behavior is wired up in later
// phases — phase 1 only lands the columns and the first-boot migration.

const CREATE_ORGANISATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lead_employee_id TEXT,
  wip_cap INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL
)
`;

const CREATE_TASKS_TABLE = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'med',
  status TEXT NOT NULL DEFAULT 'backlog',
  lead_session_id TEXT,
  supersedes_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (lead_session_id) REFERENCES sessions(id),
  FOREIGN KEY (supersedes_task_id) REFERENCES tasks(id)
)
`;

const CREATE_TASKS_ORG_INDEX = `
CREATE INDEX IF NOT EXISTS idx_tasks_organisation ON tasks (organisation_id, status)
`;

const CREATE_TASKS_STATUS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, priority DESC, created_at ASC)
`;

const CREATE_EMPLOYEES_TABLE = `
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  department TEXT,
  rank TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  UNIQUE (organisation_id, name)
)
`;

const CREATE_EMPLOYEES_ORG_INDEX = `
CREATE INDEX IF NOT EXISTS idx_employees_organisation ON employees (organisation_id)
`;

const CREATE_CRON_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  organisation_id TEXT,
  task_mode TEXT NOT NULL DEFAULT 'untracked',
  task_id TEXT,
  spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
)
`;

function parseJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as JsonObject;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToSession(row: Record<string, unknown>): Session {
  const replyContext = parseJsonObject(row.reply_context);
  const transportMeta = parseJsonObject(row.transport_meta);
  const sessionKey = ((row.session_key as string) || (row.source_ref as string));
  const connector = (row.connector as string) ?? (row.source as string) ?? null;
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    connector,
    sessionKey,
    replyContext: replyContext as ReplyContext | null,
    messageId: (row.message_id as string) ?? null,
    transportMeta,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    effortLevel: (row.effort_level as string) ?? null,
    status: row.status as Session['status'],
    totalCost: (row.total_cost as number) ?? 0,
    totalTurns: (row.total_turns as number) ?? 0,
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
    archivedTo: (row.archived_to as string) ?? null,
    archivedFrom: (row.archived_from as string) ?? null,
    summaryPrompt: (row.summary_prompt as string) ?? null,
    autoSplitDisabled: ((row.auto_split_disabled as number) ?? 0) === 1,
    organisationId: (row.organisation_id as string) ?? null,
    taskId: (row.task_id as string) ?? null,
    employeeId: (row.employee_id as string) ?? null,
  };
}

// ── Organisations (Phase 1) ─────────────────────────────────────────

function rowToOrganisation(row: Record<string, unknown>): Organisation {
  return {
    id: row.id as string,
    name: row.name as string,
    leadEmployeeId: (row.lead_employee_id as string) ?? null,
    wipCap: (row.wip_cap as number) ?? 3,
    createdAt: row.created_at as string,
  };
}

export interface CreateOrganisationOpts {
  id?: string;
  name: string;
  leadEmployeeId?: string | null;
  wipCap?: number;
}

export function createOrganisation(opts: CreateOrganisationOpts): Organisation {
  const db = initDb();
  const id = opts.id ?? uuidv4();
  const now = new Date().toISOString();
  const wipCap = opts.wipCap ?? 3;
  db.prepare(
    `INSERT INTO organisations (id, name, lead_employee_id, wip_cap, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.name, opts.leadEmployeeId ?? null, wipCap, now);
  return { id, name: opts.name, leadEmployeeId: opts.leadEmployeeId ?? null, wipCap, createdAt: now };
}

export function getOrganisation(id: string): Organisation | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM organisations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToOrganisation(row) : undefined;
}

export function listOrganisations(): Organisation[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM organisations ORDER BY created_at ASC').all() as Record<string, unknown>[];
  return rows.map(rowToOrganisation);
}

export function updateOrganisation(
  id: string,
  updates: { name?: string; leadEmployeeId?: string | null; wipCap?: number },
): Organisation | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    sets.push('name = ?');
    values.push(updates.name);
  }
  if (updates.leadEmployeeId !== undefined) {
    sets.push('lead_employee_id = ?');
    values.push(updates.leadEmployeeId);
  }
  if (updates.wipCap !== undefined) {
    sets.push('wip_cap = ?');
    values.push(updates.wipCap);
  }
  if (sets.length === 0) return getOrganisation(id);
  values.push(id);
  db.prepare(`UPDATE organisations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getOrganisation(id);
}

// ── Employees index (Phase 1) ───────────────────────────────────────

export interface EmployeeIndexRow {
  id: string;
  organisationId: string;
  name: string;
  displayName: string | null;
  department: string | null;
  rank: string | null;
  createdAt: string;
}

function rowToEmployeeIndex(row: Record<string, unknown>): EmployeeIndexRow {
  return {
    id: row.id as string,
    organisationId: row.organisation_id as string,
    name: row.name as string,
    displayName: (row.display_name as string) ?? null,
    department: (row.department as string) ?? null,
    rank: (row.rank as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function upsertEmployeeIndex(
  organisationId: string,
  emp: { name: string; displayName?: string; department?: string; rank?: string },
): EmployeeIndexRow {
  const db = initDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT * FROM employees WHERE organisation_id = ? AND name = ?')
    .get(organisationId, emp.name) as Record<string, unknown> | undefined;
  if (existing) {
    db.prepare(
      `UPDATE employees SET display_name = ?, department = ?, rank = ? WHERE id = ?`,
    ).run(emp.displayName ?? null, emp.department ?? null, emp.rank ?? null, existing.id);
    return rowToEmployeeIndex({ ...existing, display_name: emp.displayName ?? null, department: emp.department ?? null, rank: emp.rank ?? null });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO employees (id, organisation_id, name, display_name, department, rank, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, organisationId, emp.name, emp.displayName ?? null, emp.department ?? null, emp.rank ?? null, now);
  return {
    id,
    organisationId,
    name: emp.name,
    displayName: emp.displayName ?? null,
    department: emp.department ?? null,
    rank: emp.rank ?? null,
    createdAt: now,
  };
}

export function listEmployeeIndex(organisationId: string): EmployeeIndexRow[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT * FROM employees WHERE organisation_id = ? ORDER BY name ASC')
    .all(organisationId) as Record<string, unknown>[];
  return rows.map(rowToEmployeeIndex);
}

export function findEmployeeIndexByName(
  organisationId: string,
  name: string,
): EmployeeIndexRow | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM employees WHERE organisation_id = ? AND name = ?')
    .get(organisationId, name) as Record<string, unknown> | undefined;
  return row ? rowToEmployeeIndex(row) : undefined;
}

// ── Cron job index (Phase 1) ────────────────────────────────────────
//
// Cron jobs continue to live in ~/.jinn/cron/jobs.json (today's source of truth).
// This table is a synthetic index keyed by job id that lets later phases attach
// task_id / organisation_id / task_mode without changing the JSON shape.

export interface CronJobIndexRow {
  id: string;
  organisationId: string | null;
  taskMode: "untracked" | "create-task" | "resume-task";
  taskId: string | null;
  spec: CronJob;
  createdAt: string;
  updatedAt: string;
}

function rowToCronJobIndex(row: Record<string, unknown>): CronJobIndexRow {
  return {
    id: row.id as string,
    organisationId: (row.organisation_id as string) ?? null,
    taskMode: ((row.task_mode as string) ?? "untracked") as CronJobIndexRow["taskMode"],
    taskId: (row.task_id as string) ?? null,
    spec: JSON.parse((row.spec as string) || "{}") as CronJob,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function upsertCronJobIndex(
  job: CronJob,
  organisationId: string | null,
  opts: { taskMode?: CronJobIndexRow["taskMode"]; taskId?: string | null } = {},
): CronJobIndexRow {
  const db = initDb();
  const now = new Date().toISOString();
  const taskMode = opts.taskMode ?? job.taskMode ?? "untracked";
  const taskId = opts.taskId ?? job.taskId ?? null;
  const existing = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(job.id) as Record<string, unknown> | undefined;
  if (existing) {
    db.prepare(
      `UPDATE cron_jobs SET organisation_id = ?, task_mode = ?, task_id = ?, spec = ?, updated_at = ? WHERE id = ?`,
    ).run(organisationId, taskMode, taskId, JSON.stringify(job), now, job.id);
    return rowToCronJobIndex({ ...existing, organisation_id: organisationId, task_mode: taskMode, task_id: taskId, spec: JSON.stringify(job), updated_at: now });
  }
  db.prepare(
    `INSERT INTO cron_jobs (id, organisation_id, task_mode, task_id, spec, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(job.id, organisationId, taskMode, taskId, JSON.stringify(job), now, now);
  return {
    id: job.id,
    organisationId,
    taskMode,
    taskId,
    spec: job,
    createdAt: now,
    updatedAt: now,
  };
}

export function listCronJobIndex(organisationId?: string): CronJobIndexRow[] {
  const db = initDb();
  const rows = organisationId
    ? db.prepare('SELECT * FROM cron_jobs WHERE organisation_id = ? ORDER BY created_at ASC').all(organisationId)
    : db.prepare('SELECT * FROM cron_jobs ORDER BY created_at ASC').all();
  return (rows as Record<string, unknown>[]).map(rowToCronJobIndex);
}

// ── Tasks (Phase 1: skeleton helpers; full CRUD lands in phase 3) ──

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    organisationId: row.organisation_id as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    priority: ((row.priority as string) ?? 'med') as TaskPriority,
    status: row.status as TaskStatus,
    leadSessionId: (row.lead_session_id as string) ?? null,
    supersedesTaskId: (row.supersedes_task_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
    summary: (row.summary as string) ?? null,
    summaryGeneratedAt: (row.summary_generated_at as string) ?? null,
    kind: ((row.kind as string) ?? 'standard') as TaskKind,
    timeBoxHours: (row.time_box_hours as number) ?? null,
    closeNotes: (row.close_notes as string) ?? null,
  };
}

export interface CreateTaskOpts {
  id?: string;
  organisationId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  supersedesTaskId?: string | null;
  kind?: TaskKind;
  timeBoxHours?: number | null;
}

export function createTask(opts: CreateTaskOpts): Task {
  const db = initDb();
  const id = opts.id ?? uuidv4();
  const now = new Date().toISOString();
  const status = opts.status ?? 'backlog';
  const priority = opts.priority ?? 'med';
  const kind = opts.kind ?? 'standard';
  const timeBoxHours = opts.timeBoxHours ?? null;
  db.prepare(
    `INSERT INTO tasks (id, organisation_id, title, description, priority, status, supersedes_task_id, kind, time_box_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.organisationId,
    opts.title,
    opts.description ?? '',
    priority,
    status,
    opts.supersedesTaskId ?? null,
    kind,
    timeBoxHours,
    now,
    now,
  );
  return {
    id,
    organisationId: opts.organisationId,
    title: opts.title,
    description: opts.description ?? '',
    priority,
    status,
    leadSessionId: null,
    supersedesTaskId: opts.supersedesTaskId ?? null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    summary: null,
    summaryGeneratedAt: null,
    kind,
    timeBoxHours,
    closeNotes: null,
  };
}

/**
 * Set or replace a task's summary text. Bumps summary_generated_at to now so the
 * UI can show "summarised 5 min ago" without separate bookkeeping.
 */
export function setTaskSummary(id: string, summary: string | null): Task | undefined {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE tasks SET summary = ?, summary_generated_at = ?, updated_at = ? WHERE id = ?`)
    .run(summary, summary ? now : null, now, id);
  return getTask(id);
}

/** Persist the operator-supplied close notes (the spike's decision text). */
export function setTaskCloseNotes(id: string, notes: string | null): Task | undefined {
  const db = initDb();
  db.prepare(`UPDATE tasks SET close_notes = ?, updated_at = ? WHERE id = ?`)
    .run(notes, new Date().toISOString(), id);
  return getTask(id);
}

export function getTask(id: string): Task | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}

export function listTasks(filter: { organisationId?: string; status?: TaskStatus } = {}): Task[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.organisationId) {
    conditions.push('organisation_id = ?');
    values.push(filter.organisationId);
  }
  if (filter.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at ASC`)
    .all(...values) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export interface UpdateTaskFields {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  leadSessionId?: string | null;
  supersedesTaskId?: string | null;
  closedAt?: string | null;
}

export function updateTask(id: string, updates: UpdateTaskFields): Task | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.title !== undefined) {
    sets.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    sets.push('description = ?');
    values.push(updates.description);
  }
  if (updates.priority !== undefined) {
    sets.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.leadSessionId !== undefined) {
    sets.push('lead_session_id = ?');
    values.push(updates.leadSessionId);
  }
  if (updates.supersedesTaskId !== undefined) {
    sets.push('supersedes_task_id = ?');
    values.push(updates.supersedesTaskId);
  }
  if (updates.closedAt !== undefined) {
    sets.push('closed_at = ?');
    values.push(updates.closedAt);
  }
  if (sets.length === 0) return getTask(id);
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Phase 7: terminal-archive a session without spawning a successor.
 *
 * Unlike archiveSession() in archive.ts (which is for the auto-split flow and
 * creates a "[continued]" successor session), task-close archives are a one-way
 * terminal move — the task is closed, so there's nothing to continue. Children
 * keep pointing at this row (they get archived via the same task-close sweep).
 *
 * Returns true when a row was archived, false when the session was already in
 * a terminal state or not found.
 */
export function markSessionArchived(id: string): boolean {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'archived', archived_at = ?, last_activity = ?
       WHERE id = ? AND status != 'archived'`,
    )
    .run(now, now, id);
  return result.changes > 0;
}

/** Phase 7: list sessions bound to a task (any status). */
export function listSessionsForTask(taskId: string): Session[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Reverse lookup: tasks whose supersedes_task_id points at the given task.
 * Used to surface "Superseded by …" links in the UI + agent context.
 */
export function listTasksSupersedingTask(taskId: string): Task[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE supersedes_task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/**
 * Phase 5: find an existing session for (employee, taskId). Returns null when
 * no live session exists. "Live" means any status except 'archived'.
 *
 * Per-task uniqueness rule: exactly one session per (employee, task_id) pair.
 * Re-delegations to the same employee on the same task reuse this session
 * instead of spawning a new one. Two parents delegating to the same junior
 * end up at the same row (first parent wins on parent_session_id).
 */
export function findChildSessionByEmployeeAndTask(
  employee: string,
  taskId: string,
): Session | undefined {
  const db = initDb();
  const row = db
    .prepare(
      `SELECT * FROM sessions
       WHERE employee = ? AND task_id = ? AND status != 'archived'
       ORDER BY last_activity DESC LIMIT 1`,
    )
    .get(employee, taskId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  db = new Database(SESSIONS_DB);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE);
  db.exec(CREATE_MESSAGES_TABLE);
  db.exec(CREATE_MESSAGES_INDEX);
  migrateSessionsSchema(db);
  db.exec(CREATE_SESSION_KEY_INDEX);
  db.exec(CREATE_LAST_ACTIVITY_INDEX);
  db.exec(CREATE_PARENT_INDEX);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_session
      ON queue_items (session_key, status, position);
  `);
  db.exec(CREATE_FILES_TABLE);
  // Project-scoped task-bound workflow (Phase 1): tables + indexes.
  db.exec(CREATE_ORGANISATIONS_TABLE);
  db.exec(CREATE_TASKS_TABLE);
  db.exec(CREATE_TASKS_ORG_INDEX);
  db.exec(CREATE_TASKS_STATUS_INDEX);
  db.exec(CREATE_EMPLOYEES_TABLE);
  db.exec(CREATE_EMPLOYEES_ORG_INDEX);
  db.exec(CREATE_CRON_JOBS_TABLE);
  migrateTasksSchema(db);

  return db;
}

/**
 * Add columns to the `tasks` table that were introduced after Phase 1 shipped.
 * Mirrors migrateSessionsSchema(): idempotent PRAGMA-driven ALTER TABLE for any
 * column that doesn't yet exist on an existing DB. Greenfield installs get the
 * columns via CREATE TABLE (when present in the DDL); ALTER TABLE picks up
 * everything that was added post-CREATE.
 */
export function migrateTasksSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    // Closed-task summarization: one Sonnet call on close populates this so
    // future tasks (and the operator) can reference what a closed task achieved
    // without re-reading every bound session's transcript.
    ['summary', 'TEXT'],
    ['summary_generated_at', 'TEXT'],
    // Task kind: 'standard' (default — artifact-as-deliverable) or 'spike'
    // (time-boxed exploration — decision-as-deliverable). Surfaced in UI
    // and injected into the agent's task context so it knows what kind of
    // work the task represents.
    ['kind', 'TEXT', "'standard'"],
    // Spike v2: informational time box (hours). No enforcement — surfaced in
    // UI + agent context as a signal. Operator decides when to close.
    ['time_box_hours', 'INTEGER'],
    // Spike v2: decision text supplied at close. Required for spike close,
    // prepended to the summariser prompt so the retrospective can quote it.
    ['close_notes', 'TEXT'],
  ];
  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    // Auto-split mega-chats (Phase 1):
    ['archived_at', 'TEXT'],
    ['archived_to', 'TEXT'],
    ['archived_from', 'TEXT'],
    ['summary_prompt', 'TEXT'],
    ['auto_split_disabled', 'INTEGER', '0'],
    // Project-scoped task-bound workflow (Phase 1): nullable FKs to new tables.
    // Become NOT NULL in phase 5 once the per-task binding is fully wired.
    ['organisation_id', 'TEXT'],
    ['task_id', 'TEXT'],
    ['employee_id', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: ReplyContext | null;
  messageId?: string;
  transportMeta?: JsonObject | null;
  employee?: string;
  model?: string;
  title?: string;
  parentSessionId?: string;
  effortLevel?: string;
  // Project-scoped task-bound workflow (Phase 1+):
  organisationId?: string | null;
  taskId?: string | null;
  employeeId?: string | null;
}

function getNextSessionNumber(): number {
  const db = initDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  return row.count + 1;
}

function generateTitle(prompt?: string): string {
  const num = getNextSessionNumber();
  if (!prompt) return `#${num}`;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `#${num}`;
  const summary = cleaned.slice(0, 30).trim();
  return `#${num} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string; portalName?: string }): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.prompt);
  const sessionKey = opts.sessionKey ?? opts.sourceRef;
  const connector = opts.connector ?? opts.source;
  const replyContext = opts.replyContext ? JSON.stringify(opts.replyContext) : null;
  const transportMeta = opts.transportMeta ? JSON.stringify(opts.transportMeta) : null;

  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, parent_session_id, effort_level, status, created_at, last_activity,
      organisation_id, task_id, employee_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    opts.engine,
    opts.source,
    opts.sourceRef,
    connector,
    sessionKey,
    replyContext,
    opts.messageId ?? null,
    transportMeta,
    opts.employee ?? null,
    opts.model ?? null,
    title,
    opts.parentSessionId ?? null,
    opts.effortLevel ?? null,
    now,
    now,
    opts.organisationId ?? null,
    opts.taskId ?? null,
    opts.employeeId ?? null,
  );

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    connector,
    sessionKey,
    replyContext: opts.replyContext ?? null,
    messageId: opts.messageId ?? null,
    transportMeta: opts.transportMeta ?? null,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    parentSessionId: opts.parentSessionId ?? null,
    effortLevel: opts.effortLevel ?? null,
    status: 'idle',
    totalCost: 0,
    totalTurns: 0,
    createdAt: now,
    lastActivity: now,
    lastError: null,
    archivedAt: null,
    archivedTo: null,
    archivedFrom: null,
    summaryPrompt: null,
    autoSplitDisabled: false,
    organisationId: opts.organisationId ?? null,
    taskId: opts.taskId ?? null,
    employeeId: opts.employeeId ?? null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  return getSessionBySessionKey(sourceRef);
}

export function getSessionBySessionKey(sessionKey: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  engine?: string;
  engineSessionId?: string | null;
  status?: Session['status'];
  model?: string | null;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  lastActivity?: string;
  lastError?: string | null;
  title?: string;
  // Auto-split mega-chats (Phase 1):
  archivedAt?: string | null;
  archivedTo?: string | null;
  archivedFrom?: string | null;
  summaryPrompt?: string | null;
  autoSplitDisabled?: boolean;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.engine !== undefined) {
    sets.push('engine = ?');
    values.push(updates.engine);
  }
  if (updates.engineSessionId !== undefined) {
    sets.push('engine_session_id = ?');
    values.push(updates.engineSessionId);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    sets.push('model = ?');
    values.push(updates.model);
  }
  if (updates.replyContext !== undefined) {
    sets.push('reply_context = ?');
    values.push(updates.replyContext ? JSON.stringify(updates.replyContext) : null);
  }
  if (updates.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(updates.messageId);
  }
  if (updates.transportMeta !== undefined) {
    sets.push('transport_meta = ?');
    values.push(updates.transportMeta ? JSON.stringify(updates.transportMeta) : null);
  }
  if (updates.lastActivity !== undefined) {
    sets.push('last_activity = ?');
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.title !== undefined) {
    sets.push('title = ?');
    values.push(updates.title);
  }
  if (updates.archivedAt !== undefined) {
    sets.push('archived_at = ?');
    values.push(updates.archivedAt);
  }
  if (updates.archivedTo !== undefined) {
    sets.push('archived_to = ?');
    values.push(updates.archivedTo);
  }
  if (updates.archivedFrom !== undefined) {
    sets.push('archived_from = ?');
    values.push(updates.archivedFrom);
  }
  if (updates.summaryPrompt !== undefined) {
    sets.push('summary_prompt = ?');
    values.push(updates.summaryPrompt);
  }
  if (updates.autoSplitDisabled !== undefined) {
    sets.push('auto_split_disabled = ?');
    values.push(updates.autoSplitDisabled ? 1 : 0);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
  /** Phase 2: when set, restricts to sessions in this Organisation. */
  organisationId?: string;
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter?.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.engine) {
    conditions.push('engine = ?');
    values.push(filter.engine);
  }
  if (filter?.organisationId) {
    conditions.push('organisation_id = ?');
    values.push(filter.organisationId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

// Sidebar groups sessions into cron, "direct" (no employee), and per-employee
// buckets. These sentinels mirror that grouping so the server can paginate and
// count per group without the client having to load every row. Keep this SQL in
// sync with isCronSession/isDirectSession in the web chat-sidebar.
export const CRON_GROUP = '__cron__';
export const DIRECT_GROUP = '__direct__';
const IS_CRON_SQL = `(source = 'cron' OR source_ref LIKE 'cron:%')`;
const GROUP_KEY_SQL = `CASE
  WHEN ${IS_CRON_SQL} THEN '${CRON_GROUP}'
  WHEN employee IS NULL OR employee = '' THEN '${DIRECT_GROUP}'
  ELSE employee
END`;

function groupFilter(group: string): { clause: string; params: unknown[] } {
  if (group === CRON_GROUP) return { clause: IS_CRON_SQL, params: [] };
  if (group === DIRECT_GROUP)
    return { clause: `NOT ${IS_CRON_SQL} AND (employee IS NULL OR employee = '')`, params: [] };
  return { clause: `NOT ${IS_CRON_SQL} AND employee = ?`, params: [group] };
}

/** Most-recent `perGroup` sessions for each group — the bounded default payload. */
export function listRecentPerGroup(perGroup: number, organisationId?: string): Session[] {
  const db = initDb();
  const orgClause = organisationId ? 'WHERE organisation_id = ?' : '';
  const orgParams = organisationId ? [organisationId] : [];
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ${GROUP_KEY_SQL} ORDER BY last_activity DESC) AS __rn
         FROM sessions ${orgClause}
       ) WHERE __rn <= ? ORDER BY last_activity DESC`,
    )
    .all(...orgParams, perGroup) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** One group's sessions, newest first — used by the sidebar "load more" button. */
export function listSessionsForGroup(
  group: string,
  limit: number,
  offset: number,
  organisationId?: string,
): Session[] {
  const db = initDb();
  const { clause, params } = groupFilter(group);
  const orgClause = organisationId ? ' AND organisation_id = ?' : '';
  const orgParams = organisationId ? [organisationId] : [];
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE ${clause}${orgClause} ORDER BY last_activity DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, ...orgParams, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Search across ALL sessions by title / employee / id (newest first, bounded). */
export function searchSessions(query: string, limit = 100, organisationId?: string): Session[] {
  const db = initDb();
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const orgClause = organisationId ? ' AND organisation_id = ?' : '';
  const orgParams = organisationId ? [organisationId] : [];
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE (title LIKE ? ESCAPE '\\' OR employee LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')${orgClause}
       ORDER BY last_activity DESC LIMIT ?`,
    )
    .all(like, like, like, ...orgParams, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Child sessions of a parent — backed by idx_sessions_parent. */
export function listChildSessions(parentSessionId: string): Session[] {
  const db = initDb();
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY last_activity DESC`)
    .all(parentSessionId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Total session count per group, so the UI can show accurate "+N more". */
export function getSessionGroupCounts(organisationId?: string): Record<string, number> {
  const db = initDb();
  const where = organisationId ? 'WHERE organisation_id = ?' : '';
  const params = organisationId ? [organisationId] : [];
  const rows = db
    .prepare(`SELECT ${GROUP_KEY_SQL} AS grp, COUNT(*) AS n FROM sessions ${where} GROUP BY grp`)
    .all(...params) as Array<{ grp: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.grp] = r.n;
  return out;
}

/**
 * Mark any sessions stuck in "running" status as "interrupted".
 * Called on gateway startup — if the gateway is starting, no sessions can actually be running.
 * Sessions with an engine_session_id can be resumed via the Claude --resume flag.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE sessions SET status = 'interrupted', last_activity = ?, last_error = 'Interrupted: gateway restarted while session was running' WHERE status = 'running'",
  ).run(now);
  return result.changes;
}

/**
 * Get sessions that were interrupted by a gateway restart and can be resumed.
 * A session is resumable if it has an engine_session_id (Claude's internal session ID).
 */
export function getInterruptedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL ORDER BY last_activity DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Accumulate cost and turns for a session (called after each engine run).
 */
export function accumulateSessionCost(id: string, cost: number, turns: number): void {
  const db = initDb();
  db.prepare(
    'UPDATE sessions SET total_cost = total_cost + ?, total_turns = total_turns + ? WHERE id = ?',
  ).run(cost, turns, id);
}

/**
 * Duplicate a session and all its messages, returning a new session with a fresh ID.
 * Does NOT fork the engine session — the caller handles that separately.
 */
export function duplicateSession(sourceId: string, newTitle?: string): { session: Session; messageCount: number } {
  const db = initDb();
  const source = getSession(sourceId);
  if (!source) throw new Error(`Session ${sourceId} not found`);
  if (!source.engineSessionId) throw new Error(`Session ${sourceId} has no engine session ID — cannot duplicate`);

  const now = new Date().toISOString();
  const newId = uuidv4();
  const title = newTitle ?? `Copy of ${source.title || sourceId.slice(0, 8)}`;
  const newSessionKey = `web:${Date.now()}`;

  // Copy session + messages in a single transaction for consistency
  const messages = db.prepare(
    'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
  ).all(sourceId) as Array<{ role: string; content: string; timestamp: number }>;

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, connector, session_key,
        reply_context, message_id, transport_meta,
        employee, model, title, parent_session_id, effort_level, status,
        total_cost, total_turns, created_at, last_activity
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'idle', 0, 0, ?, ?)
    `).run(
      newId,
      source.engine,
      source.source,
      source.sourceRef,
      source.connector,
      newSessionKey,
      source.replyContext ? JSON.stringify(source.replyContext) : null,
      source.messageId,
      source.transportMeta ? JSON.stringify(source.transportMeta) : null,
      source.employee,
      source.model,
      title,
      source.effortLevel,
      now,
      now,
    );

    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
    );
    for (const msg of messages) {
      insertMsg.run(uuidv4(), newId, msg.role, msg.content, msg.timestamp);
    }
  });
  txn();

  const newSession = getSession(newId)!;
  return { session: newSession, messageCount: messages.length };
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSessions(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  });
  return txn();
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

export function insertMessage(sessionId: string, role: string, content: string): void {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, role, content, Date.now());
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  return db.prepare('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as SessionMessage[];
}

/**
 * Cheap COUNT for the messages of a session — used by the auto-split trigger
 * which is evaluated on every session API read.
 */
export function countMessages(sessionId: string): number {
  const db = initDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number };
  return row.n;
}

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function enqueueQueueItem(sessionId: string, sessionKey: string, prompt: string): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, position, new Date().toISOString());
  return id;
}

export function markQueueItemRunning(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running') ORDER BY position ASC"
  ).all(sessionKey) as QueueItem[];
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE status = 'running'"
  ).run();
  return result.changes;
}

/**
 * Mark sessions that have pending queue items as "interrupted" so the UI surfaces
 * a resume banner. Called on boot only when sessions.autoResumeOnBoot=false. Skips
 * sessions already in 'archived' or 'interrupted' status.
 */
export function markSessionsWithPendingQueueAsInterrupted(): number {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE sessions
    SET status = 'interrupted',
        last_activity = ?,
        last_error = COALESCE(last_error, 'Gateway restarted with pending queued messages — click Resume to dispatch')
    WHERE status NOT IN ('archived', 'interrupted')
      AND id IN (SELECT DISTINCT session_id FROM queue_items WHERE status = 'pending')
  `).run(now);
  return result.changes;
}

/**
 * Count pending queue items for a single session. Used by serializeSession to
 * drive the resume-banner copy ("N message(s) queued").
 */
export function countPendingQueueItemsForSession(sessionId: string): number {
  const db = initDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM queue_items WHERE session_id = ? AND status = 'pending'"
  ).get(sessionId) as { n: number };
  return row.n;
}

/**
 * Reset queue items currently 'running' for a single session back to 'pending'.
 * Used by the Stop endpoint so an in-flight item that gets killed mid-turn
 * remains resumable rather than being marked completed.
 */
export function resetRunningQueueItemsForSession(sessionId: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE session_id = ? AND status = 'running'"
  ).run(sessionId);
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all() as QueueItem[];
}

export function listPendingQueueItemsForSession(sessionId: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all(sessionId) as QueueItem[];
}

// ── File management ──────────────────────────────────────────────────

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  createdAt: string;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: { id: string; filename: string; size: number; mimetype: string | null; path: string | null }): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    meta.id, meta.filename, meta.size, meta.mimetype, meta.path, now,
  );
  return { ...meta, createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}
