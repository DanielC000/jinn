/**
 * Auto-split mega-chats — archive workflow (Phase 1).
 *
 * When a long-running parent session crosses the configured threshold (message
 * count or estimated token size), Jinn archives it and spawns a fresh
 * successor session that carries the prior context as a compact summary
 * injected via Claude's --append-system-prompt on every turn.
 *
 * Why a successor rather than a fork?
 *   - `claude --fork-session` copies the full transcript, which is exactly
 *     the rehydration cost we're trying to escape.
 *   - We want the new session to start with an empty Claude transcript so
 *     per-turn token cost stays flat. The summary is re-injected each turn
 *     as a system prompt — it never lands in the recorded transcript (verified
 *     2026-05-19 by inspecting jsonl event types).
 *
 * The old session stays in the DB with status='archived', linked forward via
 * archived_to so the dashboard can group it under the new chat and the user
 * can still read the original conversation.
 */
import { v4 as uuidv4 } from "uuid";
import type { Session } from "../shared/types.js";
import { initDb, getSession } from "./registry.js";
import { logger } from "../shared/logger.js";

export interface ArchiveResult {
  /** The newly-created successor session (the one the user continues in). */
  newSession: Session;
  /** Number of still-active children re-parented onto the new session. */
  reparentedChildren: number;
}

/**
 * Archive a session and spawn a successor.
 *
 * Steps performed in a single SQLite transaction:
 *   1. Insert a new session row mirroring the source (engine, employee, model,
 *      connector, parent, effort) but with a fresh id + sessionKey, the
 *      provided summary as `summary_prompt`, and `archived_from = oldId`.
 *   2. Mark the old session row archived: `status='archived'`,
 *      `archived_at=now`, `archived_to=newId`.
 *   3. Re-parent every still-active child whose `parent_session_id = oldId`
 *      to `parent_session_id = newId`. Children in terminal states (archived,
 *      error) keep pointing at the old parent so the archived chat reads
 *      consistently.
 *
 * Returns the newly-created successor session and a count of re-parented
 * children for the caller to surface to the user.
 */
export function archiveSession(oldId: string, summary: string): ArchiveResult {
  const db = initDb();
  const old = getSession(oldId);
  if (!old) {
    throw new Error(`archiveSession: session not found: ${oldId}`);
  }
  if (old.status === "archived") {
    throw new Error(`archiveSession: session ${oldId} is already archived`);
  }
  if (old.autoSplitDisabled) {
    throw new Error(`archiveSession: session ${oldId} has auto-split disabled`);
  }
  if (!summary.trim()) {
    throw new Error(`archiveSession: summary cannot be empty`);
  }

  const newId = uuidv4();
  const newSessionKey = `${old.sessionKey || old.sourceRef}::archive-${Date.now()}`;
  const now = new Date().toISOString();
  const newTitle = old.title
    ? old.title.startsWith("[continued]") ? old.title : `[continued] ${old.title}`
    : null;

  const insertNew = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, parent_session_id, effort_level, status, created_at, last_activity,
      archived_from, summary_prompt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)
  `);

  const markOldArchived = db.prepare(`
    UPDATE sessions SET status = 'archived', archived_at = ?, archived_to = ?, last_activity = ?
    WHERE id = ?
  `);

  const reparent = db.prepare(`
    UPDATE sessions SET parent_session_id = ?
    WHERE parent_session_id = ? AND status NOT IN ('archived', 'error')
  `);

  // Single transaction so we never end up with the old archived but the new
  // missing, or children re-parented to a successor that never got committed.
  const txn = db.transaction(() => {
    insertNew.run(
      newId,
      old.engine,
      old.source,
      old.sourceRef,
      old.connector,
      newSessionKey,
      old.replyContext ? JSON.stringify(old.replyContext) : null,
      old.messageId,
      old.transportMeta ? JSON.stringify(old.transportMeta) : null,
      old.employee,
      old.model,
      newTitle,
      old.parentSessionId,
      old.effortLevel,
      now,
      now,
      oldId,
      summary,
    );
    markOldArchived.run(now, newId, now, oldId);
    const r = reparent.run(newId, oldId);
    return r.changes;
  });

  const reparentedChildren = txn();
  const newSession = getSession(newId);
  if (!newSession) {
    throw new Error(`archiveSession: new session ${newId} did not persist`);
  }

  logger.info(
    `Archived session ${oldId} → ${newId} (${reparentedChildren} child(ren) re-parented)`,
  );

  return { newSession, reparentedChildren };
}

/**
 * Check whether a session is the live tip of its archive chain. Useful for
 * UI/router code that should treat archived sessions as read-only.
 */
export function isArchivedTip(session: Session): boolean {
  return session.archivedAt != null;
}

/**
 * Follow `archived_to` links forward from any session id until we reach the
 * live tip (the session with no `archived_to`). If the session id doesn't
 * exist, returns null.
 *
 * Use this when a client supplies a possibly-stale session id and we want
 * to route the message to the current successor.
 */
export function resolveCurrentSession(id: string): Session | null {
  let cur = getSession(id);
  // Cap the walk to avoid infinite loops if the DB is corrupt.
  for (let i = 0; cur && cur.archivedTo && i < 64; i++) {
    const next = getSession(cur.archivedTo);
    if (!next) break;
    cur = next;
  }
  return cur ?? null;
}

