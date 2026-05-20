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
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { initDb, getSession } from "./registry.js";
import { logger } from "../shared/logger.js";

/**
 * Built-in per-rank threshold defaults. Execs/managers receive a constant
 * stream of notification-style replies from their reports, so their chats
 * cross the message threshold much faster than ICs — fire archive earlier
 * for them by default. Overridable via `config.sessions.autoSplit.perRank`.
 */
const RANK_DEFAULTS: Record<Employee["rank"], { triggerMessages?: number; triggerTokensEstimate?: number }> = {
  executive: { triggerMessages: 60 },
  manager: { triggerMessages: 60 },
  senior: { triggerMessages: 80 },
  employee: {}, // falls through to global
};

/** Defaults that match the design doc; overridable via config.sessions.autoSplit. */
export const AUTO_SPLIT_DEFAULTS = {
  enabled: true,
  triggerMessages: 100,
  triggerTokensEstimate: 80_000,
  /**
   * mode:
   *   - "prompt"   → UI banner offers the user to archive (current default)
   *   - "silent"   → gateway archives between turns when due + queue idle
   *   - "disabled" → never archive
   *
   * Name "silent" mirrors the long-reserved entry in JinnConfig.sessions.autoSplit.mode.
   */
  mode: "prompt" as "prompt" | "silent" | "disabled",
  summarizerModel: "sonnet" as const,
};

/**
 * Locate and stat the Claude transcript jsonl for a session, returning its
 * byte count. The transcript is at `~/.claude/projects/<cwd-key>/<engineSessionId>.jsonl`,
 * but rather than recompute the cwd-key transform (which differs between
 * Claude's internal hashing and the cwd we'd know about), we walk
 * `~/.claude/projects/` and look for any directory containing the file.
 * Same approach as loadTranscriptMessages in the gateway, just statSync
 * instead of readFileSync.
 *
 * Returns 0 when:
 *   - the session has no engineSessionId yet (brand-new session)
 *   - the engine isn't Claude (we don't know where codex/gemini stash transcripts)
 *   - the file simply isn't there (e.g. running on a fresh machine)
 *
 * Cheap: one readdirSync of ~/.claude/projects (small set), then up to P
 * existsSync calls. If this turns out to be a hotspot the cwd-key could be
 * cached per session.
 */
export function getTranscriptByteEstimate(session: Session): number {
  if (!session.engineSessionId) return 0;
  if (session.engine !== "claude") return 0;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return 0;
  const projectsDir = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return 0;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(projectsDir, dir.name, `${session.engineSessionId}.jsonl`);
    try {
      const st = fs.statSync(jsonlPath);
      if (st.isFile()) return st.size;
    } catch {
      // file not in this dir — keep looking
    }
  }
  return 0;
}

/**
 * Result of checking whether a session is auto-split due.
 *
 * `trigger` identifies which threshold fired. The UI uses this to write
 * accurate banner copy: a 2-message session that tripped on bytes shouldn't
 * be shown as "This chat has 2 messages." (it tripped because the jsonl is
 * 320KB+, not because of turn count).
 */
export interface AutoSplitDueResult {
  due: boolean;
  trigger?: "messages" | "bytes";
  /** When the byte trigger fires, the rough token estimate (bytes/4) so the UI can render "~85K tokens". */
  tokensEstimate?: number;
}

/**
 * Decide whether a session should surface as "auto-split due" right now.
 *
 * Returns `due: true` when ALL of the following hold:
 *   - Auto-split is enabled in config (and not mode=disabled)
 *   - The session is not already archived
 *   - The per-session opt-out flag is false
 *   - Either message count >= triggerMessages, or the transcript jsonl is
 *     large enough that (byteSize / 4) >= triggerTokensEstimate. The /4 is
 *     the same chars→tokens estimate used by the rest of the codebase
 *     (sessions/context.ts also assumes ~4 chars per token).
 *
 * When `due: true`, `trigger` identifies which threshold fired. When the
 * byte trigger fires, `tokensEstimate` carries the rough token count.
 */
export function isAutoSplitDue(opts: {
  session: Session;
  messageCount: number;
  config?: JinnConfig;
  /** Employee record for the session's owner, if any — enables per-rank threshold overrides. */
  employee?: Employee;
}): AutoSplitDueResult {
  const { session, messageCount, config, employee } = opts;
  const cfg = resolveAutoSplitConfig(config, employee);
  if (!cfg.enabled || cfg.mode === "disabled") return { due: false };
  if (session.status === "archived") return { due: false };
  if (session.autoSplitDisabled) return { due: false };
  if (messageCount >= cfg.triggerMessages) return { due: true, trigger: "messages" };
  // Byte-based trigger: only pay the disk hit if the message-count check
  // didn't already fire — the message-count threshold is the more common path.
  const bytes = getTranscriptByteEstimate(session);
  if (bytes > 0 && bytes / 4 >= cfg.triggerTokensEstimate) {
    return { due: true, trigger: "bytes", tokensEstimate: Math.round(bytes / 4) };
  }
  return { due: false };
}

/**
 * Resolve the effective auto-split config for an employee.
 *
 * Precedence (lowest → highest):
 *   1. AUTO_SPLIT_DEFAULTS
 *   2. RANK_DEFAULTS[employee.rank]   (built-in lower triggers for execs/managers/seniors)
 *   3. config.sessions.autoSplit       (operator-set globals)
 *   4. config.sessions.autoSplit.perRank[employee.rank]   (operator-set per-rank overrides)
 *
 * Operator config overrides built-in rank defaults so users can dial seniors
 * back up if they want. Per-rank operator overrides win over global so a
 * lower exec threshold doesn't get masked by a higher global one.
 */
export function resolveAutoSplitConfig(config: JinnConfig | undefined, employee: Employee | undefined): typeof AUTO_SPLIT_DEFAULTS {
  const cfg = { ...AUTO_SPLIT_DEFAULTS };
  if (employee) {
    Object.assign(cfg, RANK_DEFAULTS[employee.rank]);
  }
  const globalCfg = config?.sessions?.autoSplit;
  if (globalCfg) {
    // Strip perRank out before merging — the table is handled separately so
    // it doesn't end up on the resolved config.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { perRank, ...rest } = globalCfg;
    Object.assign(cfg, rest);
  }
  if (employee) {
    const rankOverride = globalCfg?.perRank?.[employee.rank];
    if (rankOverride) Object.assign(cfg, rankOverride);
  }
  return cfg;
}

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
 * Append the session's `summary_prompt` (if any) to the engine systemPrompt
 * under a clearly-marked section. Use this at every engine.run() callsite
 * so successor sessions automatically carry their archived predecessor's
 * compact summary on every turn.
 *
 * If the session has no summary_prompt (i.e. it's an original, not a
 * successor), returns the systemPrompt unchanged.
 */
export function withSummaryPrompt(systemPrompt: string, session: Session): string {
  if (!session.summaryPrompt) return systemPrompt;
  return `${systemPrompt}\n\n---\n\n${session.summaryPrompt}`;
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

