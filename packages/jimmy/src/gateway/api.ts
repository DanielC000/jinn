import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { CronJob, Engine, IncomingMessage, JinnConfig, Session, StreamDelta, Target } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext } from "../sessions/context.js";
import {
  listSessions,
  listRecentPerGroup,
  listSessionsForGroup,
  getSessionGroupCounts,
  searchSessions,
  listChildSessions,
  getSession,
  accumulateSessionCost,
  countMessages,
  createSession,
  updateSession,
  UpdateSessionFields,
  deleteSession,
  deleteSessions,
  duplicateSession,
  insertMessage,
  getMessages,
  enqueueQueueItem,
  cancelQueueItem,
  getQueueItems,
  cancelAllPendingQueueItems,
  listAllPendingQueueItems,
  listPendingQueueItemsForSession,
  countPendingQueueItemsForSession,
  getFile,
  initDb,
  getTask as registryGetTask,
  listTasksSupersedingTask as registryListTasksSupersedingTask,
} from "../sessions/registry.js";
import { forkEngineSession } from "../sessions/fork.js";
import { archiveSession, isAutoSplitDue, withSummaryPrompt, AUTO_SPLIT_DEFAULTS } from "../sessions/archive.js";
import { summarizeSession } from "../sessions/summarize.js";
import { summarizeTask } from "../sessions/summarize-task.js";
import { loadTranscriptMessages } from "../sessions/transcript.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
  TMP_DIR,
  FILES_DIR,
} from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { getSttStatus, downloadModel, transcribe as sttTranscribe, resolveLanguages, WHISPER_LANGUAGES } from "../stt/stt.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveEffort } from "../shared/effort.js";
import { detectRateLimit } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt } from "../shared/usageAwareness.js";
import { handleRateLimit } from "../sessions/rate-limit-handler.js";
import { pickEncoding, compressBuffer, MIN_COMPRESS_BYTES } from "./compress.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { runCronJob } from "../cron/runner.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, ensureFilesDir } from "./files.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "../sessions/callbacks.js";
import { loadInstances } from "../cli/instances.js";
import { handleHookPost, LOOPBACK as HOOK_LOOPBACK } from "./hook-endpoint.js";

/** Max bytes accepted on /api/internal/hook (loopback-only relay payloads are tiny). */
const HOOK_BODY_MAX_BYTES = 64 * 1024;

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => JinnConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
  reloadConnectorInstances?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  hookRegistry?: import("./hook-registry.js").HookRegistry;
  hookSecret?: string;
  /** Live employee registry — getter so callers see the current map after org reloads. */
  getEmployeeRegistry?: () => Map<string, import("../shared/types.js").Employee>;
  /** PTY-backed Claude engine used by CLI-mode message sends so the user sees the
   *  prompt + response stream into the live xterm. Distinct from the headless
   *  "claude" engine in sessionManager (which chat/cron/connectors use). */
  interactiveClaudeEngine?: import("../engines/claude-interactive.js").InteractiveClaudeEngine;
}

/**
 * Dispatch every pending web queue item for a single session. Shared by:
 *   - the boot replay path (`resumePendingWebQueueItems`), which iterates all
 *     sessions when sessions.autoResumeOnBoot=true
 *   - the per-session resume endpoint (`POST /api/sessions/:id/resume`)
 *
 * Returns the number of items dispatched, or `null` when the session itself
 * cannot be dispatched (missing, not web, engine unavailable). Best-effort:
 * orphaned queue items (stale session, missing engine) are cancelled here so
 * they don't accumulate indefinitely.
 */
export function dispatchPendingForSession(sessionId: string, context: ApiContext): number | null {
  let session = getSession(sessionId);
  if (!session) return null;
  if (session.source !== "web") return null;
  session = maybeRevertEngineOverride(session);

  const config = context.getConfig();
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) {
    updateSession(session.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: `Engine "${session.engine}" not available`,
    });
    return null;
  }

  const items = listPendingQueueItemsForSession(session.id);
  if (items.length === 0) return 0;

  updateSession(session.id, {
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError: null,
  });

  let dispatched = 0;
  for (const item of items) {
    dispatchWebSessionRun(session, item.prompt, engine, config, context, { queueItemId: item.id });
    dispatched++;
  }
  return dispatched;
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  // Group by session so we only call dispatchPendingForSession once per session.
  const sessionIds = new Set<string>();
  for (const item of pending) {
    const session = getSession(item.sessionId);
    if (!session) {
      cancelQueueItem(item.id);
      continue;
    }
    sessionIds.add(item.sessionId);
  }

  let resumed = 0;
  for (const sid of sessionIds) {
    const n = dispatchPendingForSession(sid, context);
    if (n !== null) resumed += n;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

/**
 * Between-turn auto-archive. Called from inside the queue's runTask after the
 * engine finishes a turn. Triggers an archive (summarize + archiveSession +
 * cancel any newly-arrived pending notifications on the old session) when ALL
 * of the following hold:
 *   - `config.sessions.autoSplit.mode === "silent"`
 *   - the session is auto-split-due per `isAutoSplitDue()`
 *   - there are no other turns queued after this one (we're the queue tail)
 *   - the session isn't already archived (race-safe re-read)
 *
 * Best-effort: any error is logged and swallowed so a failed auto-archive
 * doesn't poison the queue task or take the session down.
 */
async function maybeAutoArchive(
  session: Session,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
): Promise<void> {
  try {
    const cfg = { ...AUTO_SPLIT_DEFAULTS, ...(config?.sessions?.autoSplit ?? {}) };
    if (cfg.mode !== "silent") return;
    if (!cfg.enabled) return;

    // Re-read so we don't act on stale flags (the user may have just clicked
    // "disable auto-split" or another worker may have already archived).
    const fresh = getSession(session.id);
    if (!fresh) return;
    if (fresh.status === "archived") return;
    if (fresh.autoSplitDisabled) return;
    // Phase 7: size-based auto-archive applies only to untracked sessions.
    // Task-bound sessions live for the lifetime of the task and are archived
    // together on task-close (no successor needed). Skipping here keeps the
    // two archive paths disjoint, so no spurious task:closed semantics arise
    // from a size-triggered archive.
    if (fresh.taskId) return;

    const messageCount = countMessages(fresh.id);
    const employee = fresh.employee ? context.getEmployeeRegistry?.().get(fresh.employee) : undefined;
    const due = isAutoSplitDue({ session: fresh, messageCount, config, employee });
    if (!due.due) return;

    // Wait until we're the last turn — defer when other notifications/messages
    // are still queued behind us. They'll fire this check on their own when
    // they're the last one standing.
    const sessionKey = fresh.sessionKey || fresh.sourceRef;
    const queuedAfterUs = context.sessionManager.getQueue().getPendingCount(sessionKey);
    if (queuedAfterUs > 0) return;

    if (!fresh.engineSessionId) {
      logger.warn(`Auto-archive skipped for ${fresh.id}: no engine_session_id yet`);
      return;
    }

    const engineConfig = fresh.engine === "codex"
      ? config.engines.codex
      : fresh.engine === "gemini"
        ? config.engines.gemini ?? config.engines.claude
        : config.engines.claude;
    const summarizerModel = cfg.summarizerModel;

    logger.info(
      `Auto-archive: ${fresh.id} (employee=${fresh.employee ?? "—"}, ${messageCount} messages, trigger=${due.trigger}) — summarizing…`,
    );

    const summary = await summarizeSession({
      session: fresh,
      engine,
      bin: engineConfig.bin,
      cwd: JINN_HOME,
      model: summarizerModel,
    });

    const { newSession, reparentedChildren } = archiveSession(fresh.id, summary);

    // Drop any notifications that landed during the summarizer pass — children
    // have already been re-parented onto the successor, so they'll re-notify
    // it as they finish their next turn. Keeping these stale items would
    // immediately re-balloon the old session's queue (which is now dead).
    // Mirror the manual DELETE /queue endpoint: both kill the in-memory chain
    // so already-pending runTasks skip their fn(), and flip DB rows to
    // 'cancelled' so the UI panel drops them.
    context.sessionManager.getQueue().clearQueue(sessionKey);
    const cancelledStale = cancelAllPendingQueueItems(sessionKey);

    logger.info(
      `Auto-archive: ${fresh.id} → ${newSession.id} (${reparentedChildren} re-parented, ${cancelledStale} stale queue items cancelled)`,
    );
    context.emit("session:archived", {
      sessionId: fresh.id,
      successorId: newSession.id,
      reparentedChildren,
      auto: true,
    });
    context.emit("session:created", { sessionId: newSession.id });
    context.emit("queue:updated", { sessionKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Auto-archive failed for ${session.id}: ${msg}`);
  }
}

function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[] },
): void {
  const run = async () => {
    await context.sessionManager.getQueue().enqueue(session.sessionKey || session.sourceRef, async () => {
      context.emit("session:started", { sessionId: session.id });
      await runWebSession(session, prompt, engine, config, context, opts?.attachments);
      // Between-turn auto-archive: when the session has crossed its threshold
      // and we're the last queued turn, summarize + archive + re-parent before
      // the next message lands. Best-effort — any failure is logged and the
      // session keeps running.
      await maybeAutoArchive(session, engine, config, context);
    }, opts?.queueItemId);
  };

  const launch = () => {
    run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", {
        sessionId: session.id,
        result: null,
        error: errMsg,
      });
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}

/** Signals that a request body exceeded the per-handler size cap. */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds maximum allowed size");
    this.name = "BodyTooLargeError";
  }
}

interface ReadBodyOpts {
  /** Hard cap on bytes accepted from the stream; rejects with BodyTooLargeError when exceeded. */
  maxBytes?: number;
}

function readBody(req: HttpRequest, opts: ReadBodyOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const max = opts.maxBytes;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (max !== undefined && total > max) {
        // Bail out — destroy the socket so the sender stops shoveling bytes.
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readBodyRaw(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
  opts: ReadBodyOpts = {},
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await readBody(req, opts);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, { error: "Payload too large" }, 413);
      return { ok: false };
    }
    throw err;
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    badRequest(res, "Invalid JSON in request body");
    return { ok: false };
  }
}

/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
function resolveAttachmentPaths(fileIds: unknown): string[] {
  if (!Array.isArray(fileIds)) return [];
  const paths: string[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (!meta) {
      logger.warn(`Attachment file not found: ${id}`);
      continue;
    }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (fs.existsSync(filePath)) {
      paths.push(filePath);
    } else if (meta.path && fs.existsSync(meta.path)) {
      paths.push(meta.path);
    } else {
      logger.warn(`Attachment file missing on disk: ${id} (${meta.filename})`);
    }
  }
  return paths;
}

/** Per-request Accept-Encoding, stashed by handleApiRequest so json() can compress. */
type ResWithEncoding = ServerResponse & { __acceptEncoding?: string };

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data));
  const enc =
    body.length >= MIN_COMPRESS_BYTES
      ? pickEncoding((res as ResWithEncoding).__acceptEncoding)
      : null;
  if (enc) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": enc,
      Vary: "Accept-Encoding",
    });
    res.end(compressBuffer(enc, body));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

// ── Phase 8a: in-memory rate limiter for the create_task agent tool ──
// Per-session counter that decays on each call. Keeps tokens cheap and
// prevents an agent feedback loop from filing 200 tasks in a minute.
const CREATE_TASK_RATE_LIMIT_PER_HOUR = 20;
const _createTaskCalls = new Map<string, number[]>(); // sessionId -> timestamps (ms)

function checkCreateTaskRateLimit(sessionId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const calls = _createTaskCalls.get(sessionId) ?? [];
  const fresh = calls.filter((t) => t >= oneHourAgo);
  if (fresh.length >= CREATE_TASK_RATE_LIMIT_PER_HOUR) {
    return { allowed: false, remaining: 0 };
  }
  fresh.push(now);
  _createTaskCalls.set(sessionId, fresh);
  return { allowed: true, remaining: CREATE_TASK_RATE_LIMIT_PER_HOUR - fresh.length };
}

/**
 * Validate a task status transition. Returns null when allowed, an error
 * message string when not. The design (per Project-Scoped Task-Bound Workflow):
 *
 *   - Allowed forward chain: backlog → todo → in-progress → waiting → review → done
 *   - Backward transitions are allowed (manual unblock by the operator).
 *   - "stalled" is set by the phase-6 reconciler from any non-terminal status,
 *     and may transition to "todo" (re-dispatch) or "done" (close-as-failed).
 *   - "done" is terminal one-way — no transition out (filing a follow-up uses
 *     supersedesTaskId on a new task).
 */
type TaskStatusName =
  | "backlog" | "todo" | "in-progress" | "waiting" | "review" | "done" | "stalled";

export function validateTaskStatusTransition(from: TaskStatusName, to: TaskStatusName): string | null {
  if (from === to) return null;
  if (from === "done") return "Task is closed (done); file a new task linked via supersedesTaskId";
  if (to === "stalled") return "stalled status is set by the reconciler, not via PATCH";
  if (from === "stalled" && !["todo", "done"].includes(to)) {
    return "stalled tasks can only move to todo (re-dispatch) or done (close-as-failed)";
  }
  const allowed: TaskStatusName[] = ["backlog", "todo", "in-progress", "waiting", "review", "done"];
  if (!allowed.includes(to)) return `unknown task status: ${to}`;
  return null;
}

const SANITIZED_KEYS = new Set(["token", "botToken", "signingSecret", "appToken"]);

/**
 * Replace any secret-bearing string fields in a connector-shaped object with
 * the "***" sentinel. Used by GET /api/config to sanitize per-connector
 * config blocks and individual instance entries before sending to the UI.
 * deepMerge round-trips the sentinel back to the original value on PUT.
 */
function sanitizeConnectorObj<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const key of SANITIZED_KEYS) {
    if (out[key]) out[key] = "***";
    else out[key] = undefined;
  }
  return out as T;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // Skip sanitized secret placeholders — keep original value
    if (SANITIZED_KEYS.has(key) && sv === "***") continue;
    if (Array.isArray(sv)) {
      // For arrays (e.g. instances), preserve secrets from matching items
      if (Array.isArray(tv)) {
        result[key] = sv.map((item: unknown) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const srcItem = item as Record<string, unknown>;
            // Find matching target item by id
            const matchTarget = (tv as unknown[]).find(
              (t) => t && typeof t === "object" && (t as Record<string, unknown>).id === srcItem.id
            ) as Record<string, unknown> | undefined;
            if (matchTarget) return deepMerge(matchTarget, srcItem);
          }
          return item;
        });
      } else {
        result[key] = sv;
      }
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Shared close ceremony: archive every bound session, persist close_notes,
 * flip task to done + closedAt, emit task:closed, fire the retrospective
 * summariser async. Invoked from BOTH:
 *   - POST /api/tasks/:id/close (operator path; carries decision body)
 *   - PATCH /api/tasks/:id status=done (agent path; no decision body)
 *
 * Without this shared helper, agents that close tasks via PATCH end up with
 * no archive + no summary — discovered live 2026-05-22 when jinn closed the
 * "Verify delegation-event rows" validation task and left the child session
 * idle + the summary unwritten.
 *
 * Spike rejection is handled by callers (only POST /close accepts spikes,
 * since PATCH has no body for the required decision).
 */
async function runCloseCeremony(
  taskId: string,
  decision: string | null,
  context: ApiContext,
): Promise<{ task: import("../shared/types.js").Task; archivedCount: number }> {
  const { getTask, updateTask, listSessionsForTask, markSessionArchived, setTaskCloseNotes } =
    await import("../sessions/registry.js");

  const bound = listSessionsForTask(taskId);
  let archivedCount = 0;
  for (const s of bound) {
    if (s.status !== "archived") {
      if (markSessionArchived(s.id)) archivedCount += 1;
    }
  }

  if (decision) setTaskCloseNotes(taskId, decision);

  const closed = updateTask(taskId, {
    status: "done",
    closedAt: new Date().toISOString(),
  });
  if (!closed) throw new Error(`runCloseCeremony: task ${taskId} vanished mid-close`);

  context.emit("task:closed", { task: closed, archivedSessions: archivedCount });
  logger.info(`[tasks] Closed task ${taskId} — archived ${archivedCount} bound session(s)${decision ? ` (with decision, ${decision.length} chars)` : ""}`);

  const cfg = context.getConfig();
  const summariseEnabled = cfg.tasks?.autoSummarizeOnClose !== false;
  if (summariseEnabled && archivedCount > 0) {
    const taskForSummariser = getTask(taskId) ?? closed; // pick up close_notes
    void runTaskSummariser(taskForSummariser, context).catch((err) => {
      logger.warn(`[tasks] Summarisation failed for task ${taskId}: ${(err as Error)?.message ?? err}`);
    });
  }

  return { task: closed, archivedCount };
}

/**
 * Run the closed-task retrospective summariser. Invoked fire-and-forget from
 * POST /api/tasks/:id/close; failures are logged but don't surface to the user
 * who already saw "task closed". Emits task:summarized on success.
 */
async function runTaskSummariser(task: import("../shared/types.js").Task, context: ApiContext): Promise<void> {
  const cfg = context.getConfig();
  // Default summariser model: the auto-split summariser's setting if set,
  // otherwise sonnet. Same model is right for both — clean Sonnet pass over
  // text, no persona resume.
  const summarizerModel = cfg.tasks?.summarizerModel
    || cfg.sessions?.autoSplit?.summarizerModel
    || "sonnet";
  const engineConfig = cfg.engines.claude;
  const engine = context.sessionManager.getEngine("claude");
  if (!engine) {
    logger.warn(`[tasks] No claude engine registered — skipping summary for task ${task.id}`);
    return;
  }
  const summary = await summarizeTask({
    task,
    engine,
    bin: engineConfig.bin,
    cwd: JINN_HOME,
    model: summarizerModel,
  });
  if (summary) {
    context.emit("task:summarized", { taskId: task.id, summary });
  }
}

function serializeSession(session: Session, context: ApiContext): Session {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  // Auto-split due check: only compute for sessions that could plausibly hit
  // the threshold — skip already-archived and opted-out ones to avoid the
  // COUNT(*) on every list call.
  let autoSplitDue: boolean | undefined;
  let autoSplitTrigger: "messages" | "bytes" | undefined;
  let autoSplitTokensEstimate: number | undefined;
  let messageCount: number | undefined;
  if (session.status !== "archived" && !session.autoSplitDisabled) {
    messageCount = countMessages(session.id);
    const employee = session.employee ? context.getEmployeeRegistry?.().get(session.employee) : undefined;
    const result = isAutoSplitDue({ session, messageCount, config: context.getConfig(), employee });
    autoSplitDue = result.due;
    autoSplitTrigger = result.trigger;
    autoSplitTokensEstimate = result.tokensEstimate;
  }
  // Resumable pending count: surfaced so the resume-banner can render accurate
  // copy ("12 message(s) queued"). Skip for archived (those rows stay frozen).
  let resumablePendingCount: number | undefined;
  if (session.status !== "archived") {
    resumablePendingCount = countPendingQueueItemsForSession(session.id);
  }
  return {
    ...session,
    queueDepth,
    transportState,
    ...(autoSplitDue !== undefined ? { autoSplitDue } : {}),
    ...(autoSplitTrigger !== undefined ? { autoSplitTrigger } : {}),
    ...(autoSplitTokensEstimate !== undefined ? { autoSplitTokensEstimate } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(resumablePendingCount !== undefined ? { resumablePendingCount } : {}),
  };
}

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/status", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";
  // Stash so json() can compress large responses without threading req everywhere.
  (res as ResWithEncoding).__acceptEncoding = req.headers["accept-encoding"];

  try {
    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      const config = context.getConfig();
      const sessions = listSessions();
      const running = sessions.filter((s) => s.status === "running").length;
      const connectors = Object.fromEntries(
        Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
      );
      return json(res, {
        status: "ok",
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        engines: {
          default: config.engines.default,
          claude: { model: config.engines.claude.model, available: true },
          codex: { model: config.engines.codex.model, available: true },
          ...(config.engines.gemini ? { gemini: { model: config.engines.gemini.model, available: true } } : {}),
        },
        sessions: { total: sessions.length, running, active: running },
        connectors,
      });
    }

    // GET /api/instances
    if (method === "GET" && pathname === "/api/instances") {
      const instances = loadInstances();
      const currentPort = context.getConfig().gateway.port || 7777;
      const results = await Promise.all(
        instances.map(async (inst) => ({
          name: inst.name,
          port: inst.port,
          running: inst.port === currentPort ? true : await checkInstanceHealth(inst.port),
          current: inst.port === currentPort,
        }))
      );
      return json(res, results);
    }

    // GET /api/sessions
    //   ?group=<employee|__direct__|__cron__>&offset=M&limit=N → one group's page (sidebar "load more")
    //   ?limit=0                                              → every session (power-user escape hatch)
    //   ?organisation=<id>                                    → filter to one Organisation (Phase 2)
    //   (default)                                             → top PER_GROUP recent per group + counts
    if (method === "GET" && pathname === "/api/sessions") {
      const organisationId = url.searchParams.get("organisation") || undefined;
      const query = url.searchParams.get("q");
      if (query && query.trim()) {
        const matches = searchSessions(query.trim(), 100, organisationId);
        return json(res, matches.map((session) => serializeSession(session, context)));
      }
      const group = url.searchParams.get("group");
      const rawLimit = url.searchParams.get("limit");
      if (group) {
        const limit = Math.max(1, parseInt(rawLimit || "50", 10) || 50);
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        const page = listSessionsForGroup(group, limit, offset, organisationId);
        return json(res, page.map((session) => serializeSession(session, context)));
      }
      if (rawLimit === "0") {
        const all = listSessions(organisationId ? { organisationId } : undefined);
        return json(res, all.map((session) => serializeSession(session, context)));
      }
      const PER_GROUP = 8;
      const sessions = listRecentPerGroup(PER_GROUP, organisationId);
      return json(res, {
        sessions: sessions.map((session) => serializeSession(session, context)),
        counts: getSessionGroupCounts(organisationId),
        perGroup: PER_GROUP,
      });
    }

    // GET /api/sessions/interrupted — list sessions that can be resumed after a restart
    if (method === "GET" && pathname === "/api/sessions/interrupted") {
      const { getInterruptedSessions } = await import("../sessions/registry.js");
      const interrupted = getInterruptedSessions();
      return json(res, interrupted.map((session) => serializeSession(session, context)));
    }

    // GET /api/sessions/:id
    let params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      let messages = getMessages(params.id);

      // Backfill from Claude Code's JSONL transcript if our DB has no messages.
      // Run async + transactional so the GET doesn't block on multi-MB JSONL
      // parsing + N individual INSERTs. Subsequent GETs will see the messages
      // once the backfill finishes; this one returns whatever is in DB now.
      if (messages.length === 0 && session.engineSessionId) {
        scheduleTranscriptBackfill(params.id, session.engineSessionId, context);
      }

      // Support ?last=N to return only the N most recent messages
      const lastN = parseInt(url.searchParams.get("last") || "0", 10);
      if (lastN > 0 && messages.length > lastN) {
        messages = messages.slice(-lastN);
      }

      return json(res, { ...serializeSession(session, context), messages });
    }

    // PUT /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "PUT" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const updates: UpdateSessionFields = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return badRequest(res, "title must be a string");
        const trimmed = body.title.trim();
        if (!trimmed) return badRequest(res, "title must not be empty");
        updates.title = trimmed.slice(0, 200);
      }
      if (body.autoSplitDisabled !== undefined) {
        if (typeof body.autoSplitDisabled !== "boolean") return badRequest(res, "autoSplitDisabled must be a boolean");
        updates.autoSplitDisabled = body.autoSplitDisabled;
      }
      if (Object.keys(updates).length === 0) return badRequest(res, "no valid fields to update");
      const updated = updateSession(params.id, updates);
      if (!updated) return notFound(res);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, serializeSession(updated, context));
    }

    // DELETE /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      // Tear down any live/warm engine process for this session before deleting it.
      // kill() is safe to call unconditionally — it's a no-op when nothing is running.
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine)) {
        logger.info(`Killing engine process for deleted session ${params.id}`);
        engine.kill(params.id, "Interrupted: session deleted");
      }

      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/stop
    // Stop = pause. Kills the in-flight engine turn (that one queue item ends
    // as DB-completed, which is fine — it actually ran), pauses the in-memory
    // queue so subsequent items don't auto-run, and marks the session
    // 'interrupted' so the chat resume-banner surfaces in the UI. The user
    // explicitly resumes via the banner (POST /api/sessions/:id/resume) or by
    // sending a fresh message (auto-resumes via PUT /api/sessions/:id at the
    // status==='interrupted' branch).
    params = matchRoute("/api/sessions/:id/stop", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine)) {
        engine.kill(params.id, "Interrupted by user");
      }
      // Pause the in-memory queue so subsequent items wait at the poll loop
      // until the user resumes. The currently-running fn() (if any) returns
      // with the kill error — that one item's DB row ends as 'completed'.
      context.sessionManager.getQueue().pauseQueue(sessionKey);
      updateSession(params.id, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted by user",
      });
      context.emit("session:stopped", { sessionId: params.id });
      context.emit("session:interrupted", { sessionId: params.id, reason: "user-stop" });
      return json(res, { status: "interrupted", sessionId: params.id });
    }

    // POST /api/sessions/:id/resume
    // Explicit user-driven resume. Two paths converge here:
    //   - Boot-time recovery: gateway booted with autoResumeOnBoot=false; queue
    //     items are pending in DB but not in the in-memory queue. Dispatch
    //     them now via dispatchPendingForSession.
    //   - Post-Stop resume: the in-memory queue is paused (via pauseQueue);
    //     pending items are sitting at the poll-wait. Unblock them.
    // Both can be true at once (boot then immediately stop), so do both.
    params = matchRoute("/api/sessions/:id/resume", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      // Unblock any in-memory items poll-waiting on pauseQueue (from user-Stop).
      context.sessionManager.getQueue().resumeQueue(sessionKey);
      // Dispatch DB-pending items that aren't already in the in-memory queue.
      // dispatchPendingForSession is idempotent for already-completed items
      // (it only looks up status='pending' rows). Items added to in-memory
      // via the existing chat-flow path won't be re-enqueued because their DB
      // row already transitioned out of 'pending' via markQueueItemRunning.
      const dispatched = dispatchPendingForSession(params.id, context);
      if (dispatched === null) {
        // Session missing/non-web/engine-unavailable. Still clear interrupted
        // state so the banner goes away.
        updateSession(params.id, {
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        context.emit("session:resumed", { sessionId: params.id, dispatched: 0 });
        return json(res, { status: "resumed", sessionId: params.id, dispatched: 0 });
      }
      // dispatchPendingForSession already flipped status='running' if it
      // enqueued items. If nothing was pending in DB but the queue had paused
      // in-memory items, the resumeQueue above will let them run — flip to
      // idle so the banner clears (or running if there were items).
      if (dispatched === 0) {
        updateSession(params.id, {
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
      }
      logger.info(`Resumed session ${params.id} — dispatched ${dispatched} pending item(s)`);
      context.emit("session:resumed", { sessionId: params.id, dispatched });
      return json(res, { status: "resumed", sessionId: params.id, dispatched });
    }

    // POST /api/sessions/:id/reset — clear stuck session state (stale engine IDs, errors)
    params = matchRoute("/api/sessions/:id/reset", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine)) {
        engine.kill(params.id, "Interrupted: session reset");
      }
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      delete meta["engineSessions"];
      delete meta["engineOverride"];
      updateSession(params.id, {
        status: "idle",
        engineSessionId: null,
        lastActivity: new Date().toISOString(),
        lastError: null,
        transportMeta: meta as any,
      });
      logger.info(`Session ${params.id} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, { status: "reset", sessionId: params.id });
    }

    // POST /api/sessions/:id/duplicate — duplicate a session (snapshot fork)
    params = matchRoute("/api/sessions/:id/duplicate", pathname);
    if (method === "POST" && params) {
      const source = getSession(params.id);
      if (!source) return notFound(res);
      if (!source.engineSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session has no engine session ID — cannot duplicate" }));
        return;
      }

      let newSessionId: string | null = null;
      try {
        // 1. Duplicate session + messages in the registry
        const { session: newSession, messageCount } = duplicateSession(params.id);
        newSessionId = newSession.id;

        // 2. Fork the engine session (Claude/Codex/Gemini) via headless fork.
        const forkResult = forkEngineSession(source.engine, source.engineSessionId, JINN_HOME);

        // 3. Store the new engine session ID
        updateSession(newSession.id, { engineSessionId: forkResult.engineSessionId });

        const result = getSession(newSession.id)!;
        logger.info(`Session duplicated: ${params.id} → ${newSession.id} (engine: ${forkResult.engineSessionId}, ${messageCount} messages)`);
        context.emit("session:created", { sessionId: newSession.id });
        return json(res, serializeSession(result, context));
      } catch (err: any) {
        // Clean up orphaned session if the engine fork failed after DB insert
        if (newSessionId) {
          try { deleteSession(newSessionId); } catch { /* best effort */ }
        }
        logger.error(`Failed to duplicate session ${params.id}: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Duplicate failed: ${err.message}` }));
        return;
      }
    }

    // POST /api/sessions/:id/archive — auto-split mega-chats workflow.
    // Body (all optional):
    //   { summary?: string,         // skip summarizer if provided (manual archive)
    //     summarizerModel?: string  // override default (sonnet)
    //   }
    // Returns the new successor session (serialized).
    params = matchRoute("/api/sessions/:id/archive", pathname);
    if (method === "POST" && params) {
      const source = getSession(params.id);
      if (!source) return notFound(res);
      if (source.status === "archived") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session is already archived", archivedTo: source.archivedTo }));
        return;
      }
      if (source.autoSplitDisabled) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Auto-split is disabled for this session" }));
        return;
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (_parsed.body as any) ?? {};

      try {
        let summary: string;
        if (typeof body.summary === "string" && body.summary.trim()) {
          summary = body.summary.trim();
          logger.info(`Archive: using caller-supplied summary for session ${source.id} (${summary.length} chars)`);
        } else {
          if (!source.engineSessionId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session has no engine_session_id — cannot auto-summarize; supply { summary } in the request body" }));
            return;
          }
          const config = context.getConfig();
          const summarizerModel = (typeof body.summarizerModel === "string" && body.summarizerModel)
            || config.sessions?.autoSplit?.summarizerModel
            || AUTO_SPLIT_DEFAULTS.summarizerModel;
          const engineConfig = source.engine === "codex"
            ? config.engines.codex
            : source.engine === "gemini"
              ? config.engines.gemini ?? config.engines.claude
              : config.engines.claude;
          const engine = context.sessionManager.getEngine(source.engine);
          if (!engine) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `No engine registered for "${source.engine}"` }));
            return;
          }
          summary = await summarizeSession({
            session: source,
            engine,
            bin: engineConfig.bin,
            cwd: JINN_HOME,
            model: summarizerModel,
          });
        }

        const { newSession, reparentedChildren } = archiveSession(source.id, summary);
        logger.info(`Archive endpoint: ${source.id} → ${newSession.id} (${reparentedChildren} children re-parented)`);
        context.emit("session:archived", { sessionId: source.id, successorId: newSession.id, reparentedChildren });
        context.emit("session:created", { sessionId: newSession.id });
        return json(res, serializeSession(newSession, context));
      } catch (err: any) {
        logger.error(`Archive failed for ${source.id}: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Archive failed: ${err.message}` }));
        return;
      }
    }

    // DELETE /api/sessions/:id/queue/:itemId — cancel specific item
    const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
    if (method === "DELETE" && queueItemParams) {
      const session = getSession(queueItemParams.id);
      if (!session) return notFound(res);
      const cancelled = cancelQueueItem(queueItemParams.itemId);
      if (!cancelled) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item not found or already running" }));
        return;
      }
      context.emit("queue:updated", { sessionId: queueItemParams.id, sessionKey: session.sessionKey });
      return json(res, { status: "cancelled", itemId: queueItemParams.itemId });
    }

    // GET /api/sessions/:id/queue
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const items = getQueueItems(session.sessionKey || session.sourceRef || session.id);
      return json(res, items);
    }

    // DELETE /api/sessions/:id/queue — clear all pending
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().clearQueue(sessionKey);
      const cancelled = cancelAllPendingQueueItems(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
      return json(res, { status: "cleared", cancelled });
    }

    // POST /api/sessions/:id/queue/pause
    params = matchRoute("/api/sessions/:id/queue/pause", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().pauseQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
      return json(res, { status: "paused", sessionId: params.id });
    }

    // POST /api/sessions/:id/queue/resume
    params = matchRoute("/api/sessions/:id/queue/resume", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().resumeQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
      return json(res, { status: "resumed", sessionId: params.id });
    }

    // POST /api/sessions/bulk-delete
    if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const ids: string[] = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, "ids array is required");

      // Tear down any live/warm engine processes before deleting. kill() is safe
      // to call unconditionally — it's a no-op when nothing is running.
      for (const id of ids) {
        const session = getSession(id);
        if (!session) continue;
        const engine = context.sessionManager.getEngine(session.engine);
        if (engine && isInterruptibleEngine(engine)) {
          engine.kill(id, "Interrupted: session deleted");
        }
      }

      const count = deleteSessions(ids);
      for (const id of ids) {
        context.emit("session:deleted", { sessionId: id });
      }
      logger.info(`Bulk deleted ${count} sessions`);
      return json(res, { status: "deleted", count });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const children = listChildSessions(params.id);
      return json(res, children.map((child) => serializeSession(child, context)));
    }

    // GET /api/sessions/:id/transcript — return raw Claude Code session transcript
    params = matchRoute("/api/sessions/:id/transcript", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      if (!session.engineSessionId) return json(res, []);
      const entries = loadRawTranscript(session.engineSessionId);
      return json(res, entries);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.prompt || body.message;
      if (!prompt) return badRequest(res, "prompt or message is required");
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;

      // ── Phase 5: task binding, per-task reuse, audit row ─────────────
      const {
        getOrganisation,
        listOrganisations,
        getTask,
        findChildSessionByEmployeeAndTask,
        findEmployeeIndexByName,
      } = await import("../sessions/registry.js");

      let taskId: string | null = null;
      let organisationId: string | null = null;
      let parentSession: Session | undefined;

      if (body.parentSessionId) {
        parentSession = getSession(body.parentSessionId);
        // Children inherit organisation_id + task_id from their parent. The
        // body cannot override this — there is no API surface for retargeting
        // a child to a different task.
        if (parentSession) {
          organisationId = parentSession.organisationId ?? null;
          taskId = parentSession.taskId ?? null;
        }
      }

      // If no parent (and so no inherited binding), accept explicit taskId from body.
      if (!taskId && typeof body.taskId === "string" && body.taskId) {
        const task = getTask(body.taskId);
        if (!task) return badRequest(res, "taskId references unknown task");
        if (!["in-progress", "waiting", "review", "todo"].includes(task.status)) {
          return badRequest(
            res,
            `taskId refers to a task in '${task.status}' status; cannot bind a session to it`,
          );
        }
        taskId = task.id;
        organisationId = task.organisationId;
      }

      // For untracked sessions, default to the first Organisation so phase 2
      // sidebar filtering works. Once an explicit ?organisation=<id> arrives
      // (sidebar-initiated chats) we can refine this; for now first wins.
      if (!organisationId) {
        if (typeof body.organisationId === "string" && body.organisationId) {
          if (!getOrganisation(body.organisationId)) {
            return badRequest(res, "organisationId references unknown Organisation");
          }
          organisationId = body.organisationId;
        } else {
          const first = listOrganisations()[0];
          if (first) organisationId = first.id;
        }
      }

      // Per-task uniqueness: if a (employee, taskId) pair already has a live
      // session, return that one instead of creating a new row. Re-delegations
      // to the same employee on the same task reuse the chat.
      if (taskId && body.employee) {
        const existing = findChildSessionByEmployeeAndTask(body.employee, taskId);
        if (existing) {
          // Append the new prompt as a user message + enqueue so the existing
          // session resumes work. The parent's audit-row is still written so
          // there's a trace of the second delegation.
          insertMessage(existing.id, "user", prompt);
          if (body.parentSessionId) {
            insertMessage(body.parentSessionId, "delegation", JSON.stringify({
              child_session_id: existing.id,
              child_employee: body.employee,
              task_id: taskId,
              reused: true,
              prompt_preview: String(prompt).slice(0, 200),
            }));
          }
          const queueItemId = enqueueQueueItem(existing.id, existing.sessionKey || existing.sourceRef || existing.id, prompt);
          context.emit("queue:updated", { sessionId: existing.id, sessionKey: existing.sessionKey });
          // Fire engine asynchronously
          const engineForExisting = context.sessionManager.getEngine(existing.engine);
          if (engineForExisting) {
            dispatchWebSessionRun(existing, prompt, engineForExisting, config, context, { queueItemId });
          }
          return json(res, serializeSession(existing, context), 200);
        }
      }

      // Resolve employee_id from the synthetic index (when the employee + org are known).
      let employeeId: string | null = null;
      if (body.employee && organisationId) {
        const idxRow = findEmployeeIndexByName(organisationId, body.employee);
        if (idxRow) employeeId = idxRow.id;
      }

      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        parentSessionId: body.parentSessionId,
        effortLevel: body.effortLevel,
        // Honor body.model so API clients can pin per-employee models
        // (e.g. MCP servers that look up org/<employee>.yaml and pass the
        // employee's configured model). Without this, runWebSession falls
        // back to config.engines.claude.model, breaking per-employee routing.
        // Fixes #38.
        model: body.model,
        prompt,
        portalName: config.portal?.portalName,
        organisationId,
        taskId,
        employeeId,
      });
      logger.info(`Web session created: ${session.id} (model=${body.model || "default"}, taskId=${taskId ?? "none"}, orgId=${organisationId ?? "none"})`);
      insertMessage(session.id, "user", prompt);

      // Phase 5e: write an audit-trail delegation row on the parent's messages
      // table whenever this is a child spawn. Lets Jinn's UI + the archive
      // grouper reconstruct delegation timelines without parsing Claude's JSONL.
      if (body.parentSessionId) {
        insertMessage(body.parentSessionId, "delegation", JSON.stringify({
          child_session_id: session.id,
          child_employee: body.employee ?? null,
          task_id: taskId,
          reused: false,
          prompt_preview: String(prompt).slice(0, 200),
        }));
      }

      // Run engine asynchronously — respond immediately, push result via WebSocket.
      // CLI-mode session creation (mode: "interactive") uses the PTY-backed engine
      // so the first turn streams into the live xterm; chat/cron/connectors use headless.
      const wantInteractive = body.mode === "interactive" && engineName === "claude";
      const engine = wantInteractive && context.interactiveClaudeEngine
        ? context.interactiveClaudeEngine
        : context.sessionManager.getEngine(engineName);
      if (!engine) {
        updateSession(session.id, {
          status: "error",
          lastError: `Engine "${engineName}" not available`,
        });
        return json(res, { ...serializeSession({ ...session, status: "error", lastError: `Engine "${engineName}" not available` }, context) }, 201);
      }

      // Set status to "running" synchronously BEFORE returning the response.
      // This prevents a race condition where the caller polls immediately and
      // sees "idle" status before runWebSession has a chance to set "running".
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      session.status = "running";

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      let session = getSession(params.id);
      if (!session) return notFound(res);
      session = maybeRevertEngineOverride(session);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = body.message || body.prompt;
      if (!prompt) return badRequest(res, "message is required");

      // Child-session callbacks (callbacks.ts) post with role='notification' so
      // the gateway renders the message as a system banner instead of a user
      // bubble, AND so a running parent turn doesn't get interrupted when a
      // sibling child finishes. See the `isNotification` branch below.
      const messageRole: "user" | "notification" = body.role === "notification" ? "notification" : "user";
      const isNotification = messageRole === "notification";
      // Dual audience: the engine (e.g. the COO) runs on the full `prompt`, while the
      // web UI persists + shows a clean `displayMessage` banner. Falls back to `prompt`.
      const displayMessage: string =
        typeof body.displayMessage === "string" && body.displayMessage.trim()
          ? body.displayMessage
          : prompt;

      const config = context.getConfig();
      // CLI-mode sends route to the interactive PTY engine so the user sees their
      // prompt injected + claude's response stream in the live xterm. All other
      // sends (chat, connectors, cron) use the headless engine.
      const wantInteractive = body.mode === "interactive" && session.engine === "claude";
      const engine = wantInteractive && context.interactiveClaudeEngine
        ? context.interactiveClaudeEngine
        : context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Persist the message immediately. For notifications, store the clean
      // human-facing `displayMessage` (what the UI banner renders) — the engine
      // still runs on the full `prompt` via the dispatch below.
      insertMessage(session.id, messageRole, isNotification ? displayMessage : prompt);
      // Push the banner live to any connected web client viewing the parent.
      if (isNotification) {
        context.emit("session:notification", { sessionId: session.id, message: displayMessage });
      }
      // Note: notification-role messages (e.g. child session callbacks) fall
      // through to enqueue + dispatch so the engine (e.g. the COO) actually
      // processes the notification and can respond — they do not return early.

      if (!isNotification && session.status === "waiting") {
        const expectedResetAt = getClaudeExpectedResetAt();
        const resumeText = expectedResetAt
          ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;
        const queuedText =
          `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. Your message is queued and will run automatically.`;
        insertMessage(session.id, "notification", queuedText);
        context.emit("session:notification", { sessionId: session.id, message: queuedText });
      }

      // If a turn is already running, check whether we should interrupt or queue.
      // Notifications (child completion callbacks) should never interrupt — just queue.
      if (session.status === "running") {
        // Only interrupt if a turn is actually in flight. With warm PTYs, isAlive is
        // also true for an idle-but-warm engine — isTurnRunning distinguishes them.
        // Headless engines lack isTurnRunning; their isAlive ≈ "turn running".
        const turnRunning = isInterruptibleEngine(engine)
          && ("isTurnRunning" in engine ? (engine as any).isTurnRunning(session.id) : engine.isAlive(session.id));
        // Notifications (child-session completion callbacks) never interrupt — they
        // queue behind the running parent turn so sequential multi-child reports
        // don't kill the parent mid-processing of an earlier sibling's reply.
        if (!isNotification && (config.sessions?.interruptOnNewMessage ?? true) && turnRunning) {
          logger.info(`Interrupting running session ${session.id} for new message`);
          engine.kill(session.id, "Interrupted: new message received");
          // SessionQueue serializes per-session; the new turn enqueued below will
          // wait for the killed run()'s promise to settle before starting.
          context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
        } else {
          context.emit("session:queued", { sessionId: session.id, message: prompt });
        }
      }

      // If session was interrupted by a restart, clear the error and resume
      if (session.status === "interrupted") {
        logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
        updateSession(session.id, {
          status: "running",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        context.emit("session:resumed", { sessionId: session.id });
      }

      // Clear any pending cancellation so the new message runs normally.
      context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, { status: "queued", sessionId: session.id });
    }

    // GET /api/cron
    //   ?organisation=<id> → filter to one Organisation (Phase 2). Cron jobs without an
    //                        organisation_id in the synthetic index are excluded.
    if (method === "GET" && pathname === "/api/cron") {
      const organisationId = url.searchParams.get("organisation") || undefined;
      let jobs = loadJobs();
      if (organisationId) {
        const { listCronJobIndex } = await import("../sessions/registry.js");
        const indexed = new Set(listCronJobIndex(organisationId).map((row) => row.id));
        jobs = jobs.filter((job) => indexed.has(job.id));
      }
      // Enrich with last run status
      const enriched = jobs.map((job) => {
        const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
        let lastRun = null;
        if (fs.existsSync(runFile)) {
          const lines = fs.readFileSync(runFile, "utf-8").trim().split("\n").filter(Boolean);
          if (lines.length > 0) {
            try { lastRun = JSON.parse(lines[lines.length - 1]); } catch {}
          }
        }
        return { ...job, lastRun };
      });
      return json(res, enriched);
    }

    // GET /api/cron/:id/runs
    params = matchRoute("/api/cron/:id/runs", pathname);
    if (method === "GET" && params) {
      const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
      if (!fs.existsSync(runFile)) return json(res, []);
      const lines = fs
        .readFileSync(runFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return json(res, lines);
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const jobs = loadJobs();
      const newJob: CronJob = {
        id: body.id || crypto.randomUUID(),
        name: body.name || "untitled",
        enabled: body.enabled ?? true,
        schedule: body.schedule || "0 * * * *",
        timezone: body.timezone,
        engine: body.engine,
        model: body.model,
        employee: body.employee,
        prompt: body.prompt || "",
        delivery: body.delivery,
      };
      jobs.push(newJob);
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, newJob, 201);
    }

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      jobs[idx] = { ...jobs[idx], ...body, id: params.id };
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, jobs[idx]);
    }

    // DELETE /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "DELETE" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const removed = jobs.splice(idx, 1)[0];
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, { deleted: removed.id, name: removed.name });
    }

    // POST /api/cron/:id/trigger — manually run a cron job now
    params = matchRoute("/api/cron/:id/trigger", pathname);
    if (method === "POST" && params) {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === params!.id);
      if (!job) return notFound(res);

      logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);

      // Fire and forget — respond immediately, run in background
      runCronJob(job, context.sessionManager, context.getConfig(), context.connectors).catch(
        (err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`)
      );

      return json(res, {
        triggered: true,
        jobId: job.id,
        name: job.name,
        employee: job.employee,
        message: `Cron job "${job.name}" triggered manually`,
      });
    }

    // GET /api/org
    // GET /api/organisations — list Organisations (Phase 1: read-only).
    if (method === "GET" && pathname === "/api/organisations") {
      const { listOrganisations } = await import("../sessions/registry.js");
      const orgs = listOrganisations();
      return json(res, orgs);
    }

    // POST /api/organisations — create a new Organisation. (Phase 2 follow-up)
    // Body: { name, leadEmployeeId?, wipCap? }
    // Side-effect: creates ~/.jinn/organisations/<id>/org/ directory on disk so
    //              employee YAMLs can be dropped in.
    if (method === "POST" && pathname === "/api/organisations") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (typeof body.name !== "string" || !body.name.trim()) {
        return badRequest(res, "name is required");
      }
      const { listOrganisations, createOrganisation } = await import("../sessions/registry.js");
      const { organisationOrgDir } = await import("../shared/paths.js");
      const existing = listOrganisations();
      if (existing.some((o) => o.name.toLowerCase() === body.name.trim().toLowerCase())) {
        return json(res, { error: `Organisation "${body.name.trim()}" already exists` }, 409);
      }
      const wipCap = body.wipCap === undefined ? 3 : Number(body.wipCap);
      if (!Number.isFinite(wipCap) || wipCap < 1) {
        return badRequest(res, "wipCap must be a positive integer");
      }
      const leadEmployeeId = body.leadEmployeeId === undefined ? null : body.leadEmployeeId;
      if (leadEmployeeId !== null && typeof leadEmployeeId !== "string") {
        return badRequest(res, "leadEmployeeId must be a string or null");
      }
      const org = createOrganisation({
        name: body.name.trim(),
        leadEmployeeId,
        wipCap: Math.floor(wipCap),
      });
      // Provision the on-disk dir so employees can be added.
      try {
        fs.mkdirSync(organisationOrgDir(org.id), { recursive: true });
      } catch (err) {
        logger.warn(`Failed to mkdir ${organisationOrgDir(org.id)}: ${err}`);
      }
      context.emit("organisation:created", { organisation: org });
      logger.info(`[organisations] Created "${org.name}" (${org.id})`);
      return json(res, org, 201);
    }

    // DELETE /api/organisations/:id — refuses when the Org owns any tasks or
    // non-archived sessions (returns 409 with counts). On success removes the
    // DB row plus the on-disk ~/.jinn/organisations/<id>/ directory tree.
    params = matchRoute("/api/organisations/:id", pathname);
    if (method === "DELETE" && params) {
      const {
        getOrganisation,
        listOrganisations,
        listTasks,
        listSessions,
      } = await import("../sessions/registry.js");
      const org = getOrganisation(params.id);
      if (!org) return notFound(res);

      const tasks = listTasks({ organisationId: params.id });
      const sessions = listSessions({ organisationId: params.id });
      const activeSessions = sessions.filter((s) => s.status !== "archived");
      if (tasks.length > 0 || activeSessions.length > 0) {
        return json(res, {
          error: "Organisation has open work — close tasks and archive sessions before deleting",
          tasks: tasks.length,
          activeSessions: activeSessions.length,
        }, 409);
      }

      // Refuse to delete the last Organisation; the UI assumes at least one exists.
      if (listOrganisations().length <= 1) {
        return json(res, { error: "Cannot delete the last Organisation" }, 409);
      }

      const { ORGANISATIONS_DIR } = await import("../shared/paths.js");
      const db = (await import("../sessions/registry.js")).initDb();
      // Cascade: drop synthetic-index rows tied to this Org first.
      db.prepare("DELETE FROM employees WHERE organisation_id = ?").run(params.id);
      db.prepare("DELETE FROM cron_jobs WHERE organisation_id = ?").run(params.id);
      db.prepare("DELETE FROM organisations WHERE id = ?").run(params.id);

      // Best-effort cleanup of the on-disk dir.
      try {
        const orgDir = path.join(ORGANISATIONS_DIR, params.id);
        if (fs.existsSync(orgDir)) {
          fs.rmSync(orgDir, { recursive: true, force: true });
        }
      } catch (err) {
        logger.warn(`Failed to remove org dir for ${params.id}: ${err}`);
      }

      context.emit("organisation:deleted", { organisationId: params.id });
      logger.info(`[organisations] Deleted "${org.name}" (${params.id})`);
      return json(res, { status: "ok" });
    }

    // GET /api/organisations/:id — single Organisation detail (Phase 1: read-only).
    params = matchRoute("/api/organisations/:id", pathname);
    if (method === "GET" && params) {
      const { getOrganisation } = await import("../sessions/registry.js");
      const org = getOrganisation(params.id);
      if (!org) return notFound(res);
      return json(res, org);
    }

    // PATCH /api/organisations/:id — update name, lead_employee_id, wip_cap (Phase 6).
    params = matchRoute("/api/organisations/:id", pathname);
    if (method === "PATCH" && params) {
      const { getOrganisation, updateOrganisation } = await import("../sessions/registry.js");
      const org = getOrganisation(params.id);
      if (!org) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const updates: { name?: string; leadEmployeeId?: string | null; wipCap?: number } = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim()) return badRequest(res, "name must be a non-empty string");
        updates.name = body.name.trim();
      }
      if (body.leadEmployeeId !== undefined) {
        if (body.leadEmployeeId !== null && typeof body.leadEmployeeId !== "string") {
          return badRequest(res, "leadEmployeeId must be a string or null");
        }
        updates.leadEmployeeId = body.leadEmployeeId;
      }
      if (body.wipCap !== undefined) {
        if (typeof body.wipCap !== "number" || !Number.isFinite(body.wipCap) || body.wipCap < 1) {
          return badRequest(res, "wipCap must be a positive integer");
        }
        updates.wipCap = Math.floor(body.wipCap);
      }
      const updated = updateOrganisation(params.id, updates);
      if (updates.wipCap !== undefined && updates.wipCap !== org.wipCap) {
        context.emit("organisation:cap-changed", { organisationId: org.id, wipCap: updates.wipCap });
      }
      context.emit("organisation:updated", { organisation: updated });
      return json(res, updated);
    }

    // POST /api/organisations/:id/reindex-employees — walk ~/.jinn/organisations/<id>/org/
    // and upsert every YAML into the synthetic `employees` index. Idempotent.
    // Needed after manual restore paths (or any time YAMLs are added/edited
    // outside the first-boot migration). Returns { scanned, inserted, updated }.
    params = matchRoute("/api/organisations/:id/reindex-employees", pathname);
    if (method === "POST" && params) {
      const { getOrganisation, upsertEmployeeIndex, listEmployeeIndex } = await import("../sessions/registry.js");
      const { organisationOrgDir } = await import("../shared/paths.js");
      const { scanOrgFromDir } = await import("./org.js");
      const org = getOrganisation(params.id);
      if (!org) return notFound(res);
      const before = new Set(listEmployeeIndex(params.id).map((e) => e.name));
      const orgDir = organisationOrgDir(params.id);
      const scanned = scanOrgFromDir(orgDir);
      let inserted = 0;
      let updated = 0;
      for (const [, emp] of scanned) {
        upsertEmployeeIndex(params.id, {
          name: emp.name,
          displayName: emp.displayName,
          department: emp.department,
          rank: emp.rank,
        });
        if (before.has(emp.name)) updated += 1;
        else inserted += 1;
      }
      return json(res, { scanned: scanned.size, inserted, updated });
    }

    // ── Tasks API (Phase 3) ────────────────────────────────────────
    // Status transition rules (validated by validateTaskStatusTransition):
    //   backlog ↔ todo ↔ in-progress ↔ waiting ↔ review ↔ done
    //   Any status → stalled (set by reconciler, phase 6) → todo (re-dispatch) | done (close-as-failed)
    //   Closed (done) tasks: terminal. No re-open. Filing a follow-up uses
    //                        supersedesTaskId on a new task.

    // GET /api/organisations/:orgId/tasks — list (optionally filterable by ?status=)
    params = matchRoute("/api/organisations/:orgId/tasks", pathname);
    if (method === "GET" && params) {
      const { getOrganisation, listTasks } = await import("../sessions/registry.js");
      if (!getOrganisation(params.orgId)) return notFound(res);
      const status = url.searchParams.get("status") as
        | "backlog" | "todo" | "in-progress" | "waiting" | "review" | "done" | "stalled"
        | null;
      const tasks = listTasks({ organisationId: params.orgId, status: status ?? undefined });
      return json(res, tasks);
    }

    // POST /api/organisations/:orgId/tasks — create
    params = matchRoute("/api/organisations/:orgId/tasks", pathname);
    if (method === "POST" && params) {
      const { getOrganisation, createTask, getTask } = await import("../sessions/registry.js");
      if (!getOrganisation(params.orgId)) return notFound(res);
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = parsed.body as any;
      if (typeof body.title !== "string" || !body.title.trim()) {
        return badRequest(res, "title is required");
      }
      const priority = body.priority as "low" | "med" | "high" | undefined;
      if (priority !== undefined && !["low", "med", "high"].includes(priority)) {
        return badRequest(res, "priority must be one of low | med | high");
      }
      const status = body.status as
        | "backlog" | "todo" | "in-progress" | "waiting" | "review" | "done"
        | undefined;
      if (status !== undefined && !["backlog", "todo", "in-progress", "waiting", "review", "done"].includes(status)) {
        return badRequest(res, "status must be a valid task status");
      }
      if (body.supersedesTaskId !== undefined && body.supersedesTaskId !== null) {
        if (typeof body.supersedesTaskId !== "string") return badRequest(res, "supersedesTaskId must be a string");
        if (!getTask(body.supersedesTaskId)) return badRequest(res, "supersedesTaskId references unknown task");
      }
      const kind = body.kind as "standard" | "spike" | undefined;
      if (kind !== undefined && kind !== "standard" && kind !== "spike") {
        return badRequest(res, "kind must be 'standard' or 'spike'");
      }
      let timeBoxHours: number | null = null;
      if (body.timeBoxHours !== undefined && body.timeBoxHours !== null) {
        if (typeof body.timeBoxHours !== "number" || !Number.isFinite(body.timeBoxHours) || body.timeBoxHours <= 0) {
          return badRequest(res, "timeBoxHours must be a positive number");
        }
        timeBoxHours = Math.round(body.timeBoxHours);
      }
      const task = createTask({
        organisationId: params.orgId,
        title: body.title.trim(),
        description: typeof body.description === "string" ? body.description : "",
        priority,
        status,
        supersedesTaskId: body.supersedesTaskId ?? null,
        kind,
        timeBoxHours,
      });
      context.emit("task:created", { task });
      return json(res, task, 201);
    }

    // GET /api/tasks/:id — single task detail with cross-task references
    params = matchRoute("/api/tasks/:id", pathname);
    if (method === "GET" && params) {
      const { getTask, listTasksSupersedingTask } = await import("../sessions/registry.js");
      const task = getTask(params.id);
      if (!task) return notFound(res);
      const successors = listTasksSupersedingTask(task.id);
      return json(res, {
        ...task,
        supersededByTaskIds: successors.map((t) => t.id),
      });
    }

    // PATCH /api/tasks/:id — update fields and/or transition status
    params = matchRoute("/api/tasks/:id", pathname);
    if (method === "PATCH" && params) {
      const { getTask, updateTask } = await import("../sessions/registry.js");
      const existing = getTask(params.id);
      if (!existing) return notFound(res);
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = parsed.body as any;

      const updates: Parameters<typeof updateTask>[1] = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || !body.title.trim()) return badRequest(res, "title must be a non-empty string");
        updates.title = body.title.trim();
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string") return badRequest(res, "description must be a string");
        updates.description = body.description;
      }
      if (body.priority !== undefined) {
        if (!["low", "med", "high"].includes(body.priority)) return badRequest(res, "priority must be low | med | high");
        updates.priority = body.priority;
      }
      // Detect a done-transition up-front so we can route it through the
      // shared close ceremony (archive bound sessions + fire summariser) rather
      // than just bumping closedAt. Spike rejection still applies — PATCH has
      // no decision body.
      let doneTransition = false;
      if (body.status !== undefined) {
        const next = body.status as
          | "backlog" | "todo" | "in-progress" | "waiting" | "review" | "done" | "stalled";
        const transitionErr = validateTaskStatusTransition(existing.status, next);
        if (transitionErr) return badRequest(res, transitionErr);
        if (next === "done" && existing.status !== "done" && existing.kind === "spike") {
          return badRequest(res, "Closing a spike requires its decision — use POST /api/tasks/:id/close with { decision: string }");
        }
        if (next === "done" && existing.status !== "done") {
          doneTransition = true;
          // Don't queue status/closedAt into the field-update path; the close
          // ceremony writes them and runs the rest of the ceremony.
        } else {
          updates.status = next;
        }
      }
      if (body.leadSessionId !== undefined) {
        if (body.leadSessionId !== null && typeof body.leadSessionId !== "string") {
          return badRequest(res, "leadSessionId must be a string or null");
        }
        updates.leadSessionId = body.leadSessionId;
      }

      // Apply any non-done field updates first (title/description/priority/
      // leadSessionId/non-done status). For pure done-transition PATCHes this
      // is a no-op.
      let updated = Object.keys(updates).length > 0 ? updateTask(params.id, updates) : existing;
      if (!updated) return notFound(res);

      if (doneTransition) {
        const { task: closed, archivedCount } = await runCloseCeremony(params.id, null, context);
        context.emit("task:status-changed", { task: closed, from: existing.status, to: "done" });
        return json(res, { ...closed, archivedSessions: archivedCount });
      }

      if (updates.status && updates.status !== existing.status) {
        context.emit("task:status-changed", { task: updated, from: existing.status, to: updates.status });
        if (updates.status === "todo" && existing.status === "backlog") {
          context.emit("task:promoted-to-todo", { task: updated });
        }
      } else {
        context.emit("task:updated", { task: updated });
      }
      return json(res, updated);
    }

    // POST /api/tasks/:id/close — terminal close. Sets status=done, closed_at,
    // archives every bound session (no successor — task is terminal), then
    // fires the retrospective summariser asynchronously (best-effort, doesn't
    // block the HTTP response). Emits task:closed; emits task:summarized later.
    //
    // Spike v2: { decision: string } is required for kind=spike close
    // (the spike's deliverable IS the decision). Persisted as close_notes
    // and prepended to the summariser prompt so the retrospective quotes it.
    // Standard tasks can also pass `decision` optionally — same storage.
    params = matchRoute("/api/tasks/:id/close", pathname);
    if (method === "POST" && params) {
      const { getTask } = await import("../sessions/registry.js");
      const existing = getTask(params.id);
      if (!existing) return notFound(res);
      if (existing.status === "done") return badRequest(res, "Task is already closed");

      // Read optional decision body — required for spikes, optional otherwise.
      let decision: string | null = null;
      try {
        const raw = await readBody(req);
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as { decision?: unknown };
          if (typeof parsed?.decision === "string" && parsed.decision.trim()) {
            decision = parsed.decision.trim();
          }
        }
      } catch { /* malformed body — fall through, validation below handles missing decision */ }
      if (existing.kind === "spike" && !decision) {
        return badRequest(res, "Spike close requires { decision: string } — the spike's deliverable IS the decision");
      }

      const { task: closed, archivedCount } = await runCloseCeremony(params.id, decision, context);
      return json(res, { ...closed, archivedSessions: archivedCount });
    }

    // POST /api/tasks/:id/resummarize — regenerate the retrospective.
    // Useful when: the original summariser run errored, the prompt template
    // changed, or the operator wants a fresh pass with updated close_notes.
    // Fire-and-forget like close; returns 202 immediately.
    params = matchRoute("/api/tasks/:id/resummarize", pathname);
    if (method === "POST" && params) {
      const { getTask } = await import("../sessions/registry.js");
      const task = getTask(params.id);
      if (!task) return notFound(res);
      void runTaskSummariser(task, context).catch((err) => {
        logger.warn(`[tasks] Resummarisation failed for task ${task.id}: ${(err as Error)?.message ?? err}`);
      });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, taskId: task.id }));
      return;
    }

    // POST /api/sessions/:sessionId/tools/create-task — Phase 8a.
    //
    // Agent-facing tool. The caller is the session executing the request;
    // we derive its organisation_id + employee from the session row and apply
    // a 20/hour per-session rate limit. Tool is restricted to executive +
    // director ranks (or any employee with `provides.create_task: true`).
    params = matchRoute("/api/sessions/:sessionId/tools/create-task", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.sessionId);
      if (!session) return notFound(res);

      // Resolve calling employee's rank.
      const registry = context.getEmployeeRegistry?.();
      const emp = session.employee ? registry?.get(session.employee) : undefined;
      const allowedRanks = ["executive", "manager"]; // includes COO + directors-as-managers
      const explicitlyEnabled = !!emp?.provides?.some((s) => s.name === "create_task");
      const rankAllowed = !emp || allowedRanks.includes(emp.rank);
      if (!explicitlyEnabled && !rankAllowed) {
        return json(res, { error: `Employee "${emp?.name ?? session.employee}" is not allowed to call create_task. Required rank: executive or manager.` }, 403);
      }

      const limit = checkCreateTaskRateLimit(params.sessionId);
      if (!limit.allowed) {
        return json(res, { error: `Rate limit exceeded: ${CREATE_TASK_RATE_LIMIT_PER_HOUR} create_task calls per hour per session.` }, 429);
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (typeof body.title !== "string" || !body.title.trim()) return badRequest(res, "title is required");
      if (!session.organisationId) return badRequest(res, "Calling session has no organisationId");

      const status = body.promote_to_todo ? "todo" : body.status ?? "backlog";
      const { createTask } = await import("../sessions/registry.js");
      const task = createTask({
        organisationId: session.organisationId,
        title: body.title.trim(),
        description: typeof body.description === "string" ? body.description : "",
        priority: body.priority ?? "med",
        status,
        supersedesTaskId: body.supersedes_task_id ?? null,
      });
      context.emit("task:created", { task, via: "tool" });
      if (status === "todo") context.emit("task:promoted-to-todo", { task });
      return json(res, { id: task.id, status: task.status, remainingCalls: limit.remaining }, 201);
    }

    // POST /api/tasks/:id/redispatch — Phase 6. Clear lead_session_id + move
    // status back to 'todo' so the picker grabs the task again on the next tick.
    params = matchRoute("/api/tasks/:id/redispatch", pathname);
    if (method === "POST" && params) {
      const { getTask, updateTask } = await import("../sessions/registry.js");
      const existing = getTask(params.id);
      if (!existing) return notFound(res);
      if (existing.status === "done") return badRequest(res, "Closed tasks cannot be re-dispatched");
      const updated = updateTask(params.id, { status: "todo", leadSessionId: null });
      context.emit("task:status-changed", { task: updated, from: existing.status, to: "todo" });
      context.emit("task:promoted-to-todo", { task: updated });
      return json(res, updated);
    }

    // DELETE /api/tasks/:id — hard delete. Useful for tests + accidentally-created tasks.
    params = matchRoute("/api/tasks/:id", pathname);
    if (method === "DELETE" && params) {
      const { deleteTask } = await import("../sessions/registry.js");
      const ok = deleteTask(params.id);
      if (!ok) return notFound(res);
      context.emit("task:deleted", { taskId: params.id });
      return json(res, { status: "ok" });
    }

    if (method === "GET" && pathname === "/api/org") {
      const organisationId = url.searchParams.get("organisation") || undefined;
      // Phase 2: when ?organisation=<id> is set, scan that Organisation's own
      // org dir at ~/.jinn/organisations/<id>/org/ instead of the legacy
      // ~/.jinn/org/. After Phase 1 migration, the legacy dir is gone; if no
      // org id was provided we fall back to the first Organisation's dir so
      // callers that haven't been Org-aware'd yet still see employees.
      const { organisationOrgDir } = await import("../shared/paths.js");
      const { listOrganisations } = await import("../sessions/registry.js");
      let scanRoot = organisationId ? organisationOrgDir(organisationId) : ORG_DIR;
      if (!fs.existsSync(scanRoot)) {
        const firstOrg = listOrganisations()[0];
        if (firstOrg) scanRoot = organisationOrgDir(firstOrg.id);
      }
      if (!fs.existsSync(scanRoot)) return json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
      const entries = fs.readdirSync(scanRoot, { withFileTypes: true });
      const departments = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      const { scanOrg, scanOrgFromDir } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = organisationId ? scanOrgFromDir(scanRoot) : scanOrg();
      const hierarchy = resolveOrgHierarchy(orgRegistry);

      const employees = hierarchy.sorted.map((name) => {
        const node = hierarchy.nodes[name];
        const emp = node.employee;
        const { persona, ...rest } = emp;
        return {
          ...rest,
          parentName: node.parentName,
          directReports: node.directReports,
          depth: node.depth,
          chain: node.chain,
        };
      });

      return json(res, {
        departments,
        employees,
        hierarchy: {
          root: hierarchy.root,
          sorted: hierarchy.sorted,
          warnings: hierarchy.warnings,
        },
      });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const emp = orgRegistry.get(params.name);
      if (!emp) return notFound(res);

      const hierarchy = resolveOrgHierarchy(orgRegistry);
      const node = hierarchy.nodes[params.name];

      return json(res, {
        ...emp,
        parentName: node?.parentName ?? null,
        directReports: node?.directReports ?? [],
        depth: node?.depth ?? 0,
        chain: node?.chain ?? [params.name],
      });
    }

    // PATCH /api/org/employees/:name — update employee fields (currently only alwaysNotify)
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "PATCH" && params) {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as any;
      const { updateEmployeeYaml } = await import("./org.js");
      const updated = updateEmployeeYaml(params.name, {
        alwaysNotify: typeof body.alwaysNotify === "boolean" ? body.alwaysNotify : undefined,
      });
      if (!updated) return notFound(res);
      context.emit("org:updated", { employee: params.name });
      return json(res, { status: "ok" });
    }

    // GET /api/org/departments/:name/board
    params = matchRoute("/api/org/departments/:name/board", pathname);
    if (method === "GET" && params) {
      const boardPath = path.join(ORG_DIR, params.name, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      const board = JSON.parse(fs.readFileSync(boardPath, "utf-8"));
      return json(res, board);
    }

    // PUT /api/org/departments/:name/board
    if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) {
      const p = matchRoute("/api/org/departments/:name/board", pathname)!;
      const boardPath = path.join(ORG_DIR, p.name, "board.json");
      const deptDir = path.join(ORG_DIR, p.name);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: p.name });
      return json(res, { status: "ok" });
    }

    // GET /api/skills
    //   ?organisation=<id> → merge per-Org overlay at ~/.jinn/organisations/<id>/skills/
    //                        on top of global ~/.jinn/skills/. Per-Org wins on name
    //                        collision (Phase 8c — mirrors Claude Code's .claude/skills
    //                        precedence model).
    if (method === "GET" && pathname === "/api/skills") {
      const organisationId = url.searchParams.get("organisation") || undefined;
      const { organisationSkillsDir } = await import("../shared/paths.js");
      const dirs: string[] = [];
      if (organisationId) {
        const perOrg = organisationSkillsDir(organisationId);
        if (fs.existsSync(perOrg)) dirs.push(perOrg);
      }
      if (fs.existsSync(SKILLS_DIR)) dirs.push(SKILLS_DIR);
      if (dirs.length === 0) return json(res, []);

      // Merge order: earlier dirs win on collision (per-Org first).
      const byName = new Map<string, { name: string; description: string; source: "organisation" | "global" }>();
      for (const dir of dirs) {
        const source: "organisation" | "global" = dir === SKILLS_DIR ? "global" : "organisation";
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (byName.has(e.name)) continue; // first wins (per-Org overlay)
          const skillMdPath = path.join(dir, e.name, "SKILL.md");
          let description = "";
          if (fs.existsSync(skillMdPath)) {
            const content = fs.readFileSync(skillMdPath, "utf-8");
            const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (frontmatterMatch) {
              const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
              if (descMatch) description = descMatch[1].trim();
            }
            if (!description) {
              const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
              if (triggerMatch) {
                description = triggerMatch[1].trim();
              } else {
                const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
                const lines = bodyContent.split("\n");
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith("#")) {
                    description = trimmed;
                    break;
                  }
                }
              }
            }
          }
          byName.set(e.name, { name: e.name, description, source });
        }
      }
      return json(res, Array.from(byName.values()));
    }

    // GET /api/skills/:name
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "GET" && params) {
      const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return notFound(res);
      const content = fs.readFileSync(skillMd, "utf-8");
      return json(res, { name: params.name, content });
    }

    // DELETE /api/skills/:name — remove a skill
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "DELETE" && params) {
      const skillDir = path.join(SKILLS_DIR, params.name);
      if (!fs.existsSync(skillDir)) return notFound(res);
      fs.rmSync(skillDir, { recursive: true, force: true });
      const { removeFromManifest } = await import("../cli/skills.js");
      removeFromManifest(params.name);
      logger.info(`Skill removed via API: ${params.name}`);
      return json(res, { status: "removed", name: params.name });
    }

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      // Sanitize: remove any secrets/tokens from connectors
      const rawConnectors = config.connectors || {};
      const sanitizedConnectors: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawConnectors)) {
        if (k === "instances" && Array.isArray(v)) {
          sanitizedConnectors.instances = v.map((inst: any) =>
            inst && typeof inst === "object" ? sanitizeConnectorObj(inst) : inst,
          );
        } else if (v && typeof v === "object") {
          sanitizedConnectors[k] = sanitizeConnectorObj(v as Record<string, unknown>);
        } else {
          sanitizedConnectors[k] = v;
        }
      }
      const sanitized = {
        ...config,
        connectors: sanitizedConnectors,
      };
      return json(res, sanitized);
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      // Basic validation: must be a plain object
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "Config must be a JSON object");
      }
      // Validate known top-level keys
      // Keep this aligned with `JinnConfig` in src/shared/types.ts
      const KNOWN_KEYS = [
        "jinn",
        "gateway",
        "engines",
        "connectors",
        "logging",
        "mcp",
        "sessions",
        "cron",
        "notifications",
        "portal",
        "context",
        "stt",
        "skills",
        "remotes",
      ];
      const unknownKeys = Object.keys(body).filter((k) => !KNOWN_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return badRequest(res, `Unknown config keys: ${unknownKeys.join(", ")}`);
      }
      // Validate critical field types
      if (body.gateway !== undefined) {
        if (typeof body.gateway !== "object" || Array.isArray(body.gateway)) {
          return badRequest(res, "gateway must be an object");
        }
        if (body.gateway.port !== undefined && typeof body.gateway.port !== "number") {
          return badRequest(res, "gateway.port must be a number");
        }
      }
      if (body.engines !== undefined && (typeof body.engines !== "object" || Array.isArray(body.engines))) {
        return badRequest(res, "engines must be an object");
      }
      // Deep-merge incoming config with existing config to preserve
      // fields not included in the update (e.g. connector tokens).
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, body);
      const yamlStr = yaml.dump(merged);
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info("Config updated via API");
      return json(res, { status: "ok" });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      // Read only the last 64KB to avoid loading the entire file into memory
      const MAX_BYTES = 64 * 1024;
      const stat = fs.statSync(logFile);
      const readSize = Math.min(stat.size, MAX_BYTES);
      const fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const allLines = buf.toString("utf-8").split("\n").filter(Boolean);
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/reload — stop all instance connectors and restart from config
    if (method === "POST" && pathname === "/api/connectors/reload") {
      if (!context.reloadConnectorInstances) {
        return json(res, { error: "Connector reload not available" }, 501);
      }
      try {
        const result = await context.reloadConnectorInstances();
        context.emit("connectors:reloaded", result);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/connectors/:id/incoming — receive proxied Discord messages from primary instance
    // Supports both the legacy /api/connectors/discord/incoming and named instance ids
    params = matchRoute("/api/connectors/:id/incoming", pathname);
    if (method === "POST" && params && params.id) {
      // Try the exact instance id first, then fall back to "discord" for the legacy path
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);
      if (!("deliverMessage" in connector)) {
        return json(res, { error: "Discord connector is not in remote mode" }, 400);
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Download attachments from Discord CDN URLs to local temp
      const { downloadAttachment } = await import("../connectors/discord/format.js");
      const attachments = await Promise.all(
        (body.attachments || []).map(async (att: { name: string; url: string; mimeType: string }) => {
          if (att.url) {
            try {
              const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
              return { name: att.name, url: att.url, mimeType: att.mimeType, localPath };
            } catch {
              return { name: att.name, url: att.url, mimeType: att.mimeType };
            }
          }
          return att;
        }),
      );

      const incomingMsg: IncomingMessage = {
        connector: params.id,
        source: "discord",
        sessionKey: body.sessionKey,
        channel: body.channel,
        thread: body.thread,
        user: body.user,
        userId: body.userId,
        text: body.text,
        messageId: body.messageId,
        attachments,
        replyContext: body.replyContext || {},
        transportMeta: body.transportMeta,
        raw: body,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connector as any).deliverMessage(incomingMsg);
      return json(res, { status: "delivered" });
    }

    // POST /api/connectors/:id/proxy — proxy connector operations from remote instances
    // Supports both the legacy /api/connectors/discord/proxy and named instance ids
    params = matchRoute("/api/connectors/:id/proxy", pathname);
    if (method === "POST" && params && params.id) {
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      const action = body.action as string;
      const target = body.target as Target | undefined;
      let messageId: string | undefined;

      switch (action) {
        case "sendMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.sendMessage(target, body.text)) as string | undefined;
          break;
        case "replyMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.replyMessage(target, body.text)) as string | undefined;
          break;
        case "editMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          await connector.editMessage(target, body.text);
          break;
        case "addReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.addReaction(target, body.emoji);
          break;
        case "removeReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.removeReaction(target, body.emoji);
          break;
        case "setTypingStatus":
          if (connector.setTypingStatus) {
            await connector.setTypingStatus(body.channelId ?? "", body.threadTs, body.status ?? "");
          }
          break;
        default:
          return badRequest(res, `Unknown proxy action: ${action}`);
      }

      return json(res, { status: "ok", messageId });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      await connector.sendMessage(
        { channel: body.channel, thread: body.thread },
        body.text,
      );
      return json(res, { status: "sent" });
    }

    // GET /api/connectors/whatsapp/qr — return current QR code as PNG data URL
    if (method === "GET" && pathname === "/api/connectors/whatsapp/qr") {
      const waConnector = context.connectors.get("whatsapp");
      if (!waConnector) return notFound(res);
      const qrString = (waConnector as WhatsAppConnector).getQrCode();
      if (!qrString) return json(res, { qr: null });
      const dataUrl = await QRCode.toDataURL(qrString, { width: 256, margin: 2 });
      return json(res, { qr: dataUrl });
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const connectors = Array.from(context.connectors.entries()).map(([instanceId, connector]) => ({
        name: connector.name,
        instanceId,
        employee: connector.getEmployee?.() ?? undefined,
        ...connector.getHealth(),
      }));
      return json(res, connectors);
    }

    // GET /api/activity — recent activity derived from sessions
    if (method === "GET" && pathname === "/api/activity") {
      const sessions = listSessions();
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (const s of sessions) {
        const ts = new Date(s.lastActivity || s.createdAt).getTime();
        const transportState = context.sessionManager.getQueue().getTransportState(s.sessionKey || s.sourceRef, s.status);
        if (transportState === "running") {
          events.push({ event: "session:started", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "queued") {
          events.push({ event: "session:queued", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "idle") {
          events.push({ event: "session:completed", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "error") {
          events.push({ event: "session:error", payload: { sessionId: s.id, employee: s.employee, error: s.lastError, connector: s.connector }, ts });
        }
      }
      events.sort((a, b) => b.ts - a.ts);
      return json(res, events.slice(0, 30));
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      const sessions = listSessions();
      const hasEmployees = fs.existsSync(ORG_DIR) &&
        fs.readdirSync(ORG_DIR, { recursive: true }).some(
          (f) => String(f).endsWith(".yaml") && !String(f).endsWith("department.yaml")
        );
      const config = context.getConfig();
      const onboarded = config.portal?.onboarded === true;
      return json(res, {
        needed: !onboarded && sessions.length === 0 && !hasEmployees,
        onboarded,
        sessionsCount: sessions.length,
        hasEmployees,
        portalName: config.portal?.portalName ?? null,
        operatorName: config.portal?.operatorName ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const { portalName, operatorName, language } = body;

      // Read current config and merge portal settings
      const config = context.getConfig();
      const updated = {
        ...config,
        portal: {
          ...config.portal,
          onboarded: true,
          ...(portalName !== undefined && { portalName: portalName || undefined }),
          ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
          ...(language !== undefined && { language: language || undefined }),
        },
      };

      // Write updated config
      const yamlStr = yaml.dump(updated, { lineWidth: -1 });
      fs.writeFileSync(CONFIG_PATH, yamlStr);
      logger.info(`Onboarding: portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      const effectiveName = portalName || "Jinn";
      const languageSection = language && language !== "English"
        ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
        : "";

      // Update CLAUDE.md with personalized COO name and language
      const claudeMdPath = path.join(JINN_HOME, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) {
        let claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
        // Replace the identity line in CLAUDE.md
        claudeMd = claudeMd.replace(
          /^You are \w+, the COO of the user's AI organization\.$/m,
          `You are ${effectiveName}, the COO of the user's AI organization.`,
        );
        // Remove existing language section if present, then add new one if needed
        claudeMd = claudeMd.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          claudeMd = claudeMd.trimEnd() + languageSection + "\n";
        }
        fs.writeFileSync(claudeMdPath, claudeMd);
      }

      // Update AGENTS.md with personalized name and language
      const agentsMdPath = path.join(JINN_HOME, "AGENTS.md");
      if (fs.existsSync(agentsMdPath)) {
        let agentsMd = fs.readFileSync(agentsMdPath, "utf-8");
        // Replace the bold identity line (e.g. "You are **Jinn**")
        agentsMd = agentsMd.replace(
          /You are \*\*\w+\*\*/,
          `You are **${effectiveName}**`,
        );
        // Remove existing language section if present, then add new one if needed
        agentsMd = agentsMd.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          agentsMd = agentsMd.trimEnd() + languageSection + "\n";
        }
        fs.writeFileSync(agentsMdPath, agentsMd);
      }

      context.emit("config:updated", { portal: updated.portal });
      return json(res, { status: "ok", portal: updated.portal });
    }

    // ── STT (Speech-to-Text) ──────────────────────────────────
    if (method === "GET" && pathname === "/api/stt/status") {
      const config = context.getConfig();
      const languages = resolveLanguages(config.stt);
      const status = getSttStatus(config.stt?.model, languages);
      return json(res, status);
    }

    if (method === "POST" && pathname === "/api/stt/download") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";

      downloadModel(model, (progress) => {
        context.emit("stt:download:progress", { progress });
      }).then(() => {
        // Update config to mark STT as enabled
        try {
          const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
          const sttCfg = cfg.stt as Record<string, unknown>;
          sttCfg.enabled = true;
          sttCfg.model = model;
          if (!sttCfg.languages) sttCfg.languages = ["en"];
          fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
        } catch (err) {
          logger.error(`Failed to update config after STT download: ${err}`);
        }
        context.emit("stt:download:complete", { model });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT download failed: ${msg}`);
        context.emit("stt:download:error", { error: msg });
      });

      return json(res, { status: "downloading", model });
    }

    if (method === "POST" && pathname === "/api/stt/transcribe") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";
      const languages = resolveLanguages(config.stt);
      // Accept language from query param, fall back to first configured language
      const requestedLang = url.searchParams.get("language");
      const language = requestedLang && languages.includes(requestedLang) ? requestedLang : languages[0];

      const audioBuffer = await readBodyRaw(req);
      if (audioBuffer.length === 0) return badRequest(res, "No audio data");
      if (audioBuffer.length > 100 * 1024 * 1024) return badRequest(res, "Audio too large (100MB max)");

      const contentType = req.headers["content-type"] || "audio/webm";
      const ext = contentType.includes("wav") ? ".wav"
        : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
        : contentType.includes("ogg") ? ".ogg"
        : ".webm";

      const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, audioBuffer);

      try {
        const text = await sttTranscribe(tmpFile, model, language);
        return json(res, { text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT transcription failed: ${msg}`);
        return serverError(res, `Transcription failed: ${msg}`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }

    if (method === "PUT" && pathname === "/api/stt/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const langs = body.languages;

      if (!Array.isArray(langs) || langs.length === 0) {
        return badRequest(res, "languages must be a non-empty array");
      }

      const invalid = langs.filter((l) => typeof l !== "string" || !WHISPER_LANGUAGES[l]);
      if (invalid.length > 0) {
        return badRequest(res, `Invalid language codes: ${invalid.join(", ")}`);
      }

      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
        const sttCfg = cfg.stt as Record<string, unknown>;
        sttCfg.languages = langs;
        // Remove deprecated language field if present
        delete sttCfg.language;
        fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
        return json(res, { status: "ok", languages: langs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, `Failed to update STT config: ${msg}`);
      }
    }

    // /api/files — file upload/download/management
    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, pathname, method, context);
      if (handled) return;
    }

    // POST /api/internal/hook — receive Claude Code turn hooks from the relay script
    if (method === "POST" && pathname === "/api/internal/hook") {
      if (!context.hookRegistry || !context.hookSecret) {
        return json(res, { error: "Interactive mode not active" }, 503);
      }
      // Loopback check FIRST — before reading the body — so a non-loopback
      // caller can't force unbounded body buffering by sending a huge POST.
      const remote = req.socket.remoteAddress;
      if (!remote || !HOOK_LOOPBACK.has(remote)) {
        return json(res, { message: "forbidden" }, 403);
      }
      // Reject oversized bodies up front via Content-Length, then enforce
      // the cap mid-stream too in case the header was missing or lies.
      const contentLength = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > HOOK_BODY_MAX_BYTES) {
        return json(res, { error: "Payload too large" }, 413);
      }
      const _parsed = await readJsonBody(req, res, { maxBytes: HOOK_BODY_MAX_BYTES });
      if (!_parsed.ok) return;
      const hookBody = _parsed.body as { jinnSessionId?: string; hook?: import("./hook-registry.js").HookPayload };
      const result = handleHookPost(
        { reg: context.hookRegistry, secret: context.hookSecret, remoteAddress: remote },
        req.headers["x-jinn-hook-secret"] as string | undefined,
        hookBody,
      );
      return json(res, { message: result.body }, result.status);
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    return serverError(res, msg);
  }
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: TranscriptContentBlock[];
}

function loadRawTranscript(engineSessionId: string): TranscriptEntry[] {
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const entries: TranscriptEntry[] = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        const rawContent = msg.content;
        const blocks: TranscriptContentBlock[] = [];

        if (typeof rawContent === "string") {
          if (rawContent.trim()) blocks.push({ type: "text", text: rawContent });
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            const blockType = String(b.type || "");
            if (blockType === "text") {
              blocks.push({ type: "text", text: String(b.text || "") });
            } else if (blockType === "tool_use") {
              blocks.push({
                type: "tool_use",
                name: String(b.name || ""),
                input: (b.input as Record<string, unknown>) || {},
              });
            } else if (blockType === "tool_result") {
              const resultContent = b.content;
              let resultText: string;
              if (typeof resultContent === "string") {
                resultText = resultContent;
              } else if (Array.isArray(resultContent)) {
                resultText = (resultContent as Record<string, unknown>[])
                  .filter((rc) => rc.type === "text")
                  .map((rc) => String(rc.text || ""))
                  .join("");
              } else {
                resultText = "";
              }
              blocks.push({ type: "tool_result", text: resultText });
            } else if (blockType === "thinking") {
              blocks.push({ type: "thinking", text: String(b.thinking || b.text || "") });
            }
          }
        }

        if (blocks.length > 0) {
          entries.push({ role: type as "user" | "assistant", content: blocks });
        }
      } catch {
        continue;
      }
    }
    return entries;
  }
  return [];
}

/**
 * Track which sessions currently have an in-flight transcript backfill so
 * concurrent GETs don't kick off duplicate (expensive) parses. Once a backfill
 * finishes and inserts rows, subsequent GETs see messages.length > 0 and skip
 * scheduling entirely.
 */
const backfillInProgress = new Set<string>();

function scheduleTranscriptBackfill(sessionId: string, engineSessionId: string, context: ApiContext): void {
  if (backfillInProgress.has(sessionId)) return;
  backfillInProgress.add(sessionId);
  // Defer off the request-handling tick so the GET returns immediately.
  setImmediate(() => {
    try {
      // Re-check inside the deferred task: another concurrent GET may have
      // backfilled this session already (extremely unlikely given the Set
      // guard, but cheap insurance).
      const existing = getMessages(sessionId);
      if (existing.length > 0) return;
      const transcriptMessages = loadTranscriptMessages(engineSessionId);
      if (transcriptMessages.length === 0) return;
      // One transaction for the whole backfill — better-sqlite3 executes the
      // inner inserts synchronously inside a single BEGIN/COMMIT, which is
      // dramatically faster than autocommitting per row.
      const db = initDb();
      const txn = db.transaction((items: Array<{ role: string; content: string }>) => {
        for (const tm of items) {
          insertMessage(sessionId, tm.role, tm.content);
        }
      });
      txn(transcriptMessages);
      logger.info(`Backfilled ${transcriptMessages.length} transcript message(s) for session ${sessionId}`);
      // Notify subscribers (web client) so they re-fetch and display the
      // newly backfilled messages instead of waiting for another event.
      context.emit("session:updated", { sessionId });
    } catch (err) {
      logger.warn(`Transcript backfill failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
    } finally {
      backfillInProgress.delete(sessionId);
    }
  });
}

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  attachments?: string[],
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }
  logger.info(`Web session ${currentSession.id} running engine "${currentSession.engine}" (model: ${currentSession.model || "default"})`);

  // Ensure status is "running" (may already be set by the POST handler)
  const currentStatus = getSession(currentSession.id);
  if (currentStatus && currentStatus.status !== "running") {
    updateSession(currentSession.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
  }

  // If this session has an assigned employee, load their persona
  let employee: import("../shared/types.js").Employee | undefined;
  if (currentSession.employee) {
    const { findEmployee } = await import("./org.js");
    const { scanOrg } = await import("./org.js");
    const registry = scanOrg();
    employee = findEmployee(currentSession.employee, registry);
  }

  const { scanOrg: scanOrgForHierarchy } = await import("./org.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const orgHierarchy = resolveOrgHierarchy(scanOrgForHierarchy());

  try {

    // Resolve the bound task (if any) so the agent sees its title, status, and
    // cross-task chain in the context block — mirrors manager.ts dispatch.
    let webTaskContext = null;
    if (currentSession.taskId) {
      const t = registryGetTask(currentSession.taskId);
      if (t) {
        webTaskContext = {
          task: t,
          supersedes: t.supersedesTaskId ? registryGetTask(t.supersedesTaskId) ?? null : null,
          supersededBy: registryListTasksSupersedingTask(t.id),
        };
      }
    }

    const systemPrompt = buildContext({
      source: "web",
      channel: currentSession.sourceRef,
      user: "web-user",
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
      hierarchy: orgHierarchy,
      taskContext: webTaskContext,
    });

    const engineConfig = currentSession.engine === "codex"
      ? config.engines.codex
      : currentSession.engine === "gemini"
        ? config.engines.gemini ?? config.engines.claude
        : config.engines.claude;
    const effortLevel = resolveEffort(engineConfig, currentSession, employee);
    // Resolve the model up front so we can both pass it to the engine and
    // persist it back to the session row on first completion (web sessions
    // are created with model=null when the client doesn't pin one).
    const resolvedModel = currentSession.model ?? engineConfig.model ?? null;
    const persistModel = currentSession.model == null && resolvedModel != null;

    let lastHeartbeatAt = 0;
    const runHeartbeat = setInterval(() => {
      // If the session was deleted mid-turn, stop heartbeating immediately —
      // the engine.run promise may still take minutes to resolve, and we don't
      // want to keep writing status:"running" rows for a session the user
      // already removed (and risk re-creating registry state in some paths).
      if (!getSession(currentSession.id)) {
        clearInterval(runHeartbeat);
        return;
      }
      updateSession(currentSession.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
    }, 5000);

    const syncSinceIso = (currentSession.transportMeta as any)?.claudeSyncSince;
    const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
    const syncRequested = currentSession.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
    const promptToRun = syncRequested
      ? (() => {
        const sinceMessages = getMessages(currentSession.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        return `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      })()
      : prompt;

    const result = await engine.run({
      prompt: promptToRun,
      resumeSessionId: currentSession.engineSessionId ?? undefined,
      systemPrompt: withSummaryPrompt(systemPrompt, currentSession),
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: resolvedModel ?? engineConfig.model,
      effortLevel,
      cliFlags: employee?.cliFlags,
      attachments: attachments?.length ? attachments : undefined,
      sessionId: currentSession.id,
      source: currentSession.source,
      onStream: (delta) => {
        // Same guard as runHeartbeat: a delta may arrive after the user
        // deleted the session; don't resurrect registry state for it.
        if (!getSession(currentSession.id)) return;
        const now = Date.now();
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSession(currentSession.id, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: delta.type,
            content: delta.content,
            toolName: delta.toolName,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
      },
    }).finally(() => {
      clearInterval(runHeartbeat);
    });

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    const wasInterrupted = result.error?.startsWith("Interrupted");
    const rateLimit = !wasInterrupted ? detectRateLimit(result) : { limited: false as const };

    if (rateLimit.limited) {
      const emitDelta = (delta: StreamDelta) => {
        context.emit("session:delta", {
          sessionId: currentSession.id,
          type: delta.type,
          content: delta.content,
          toolName: delta.toolName,
        });
      };

      const outcome = await handleRateLimit({
        session: currentSession,
        prompt,
        systemPrompt,
        engineConfig,
        effortLevel,
        cliFlags: employee?.cliFlags,
        attachments: attachments?.length ? attachments : undefined,
        config,
        engines: context.sessionManager.getEngines(),
        employee,
        engine,
        rateLimit,
        originalResult: result,
        hooks: {
          onFallbackStart: ({ resumeAt }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;
            const notificationText =
              `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`;
            insertMessage(currentSession.id, "notification", notificationText);

            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} switching to GPT.`,
            );
          },
          onFallbackStream: emitDelta,
          onFallbackComplete: (fallbackResult) => {
            if (fallbackResult.result) {
              insertMessage(currentSession.id, "assistant", fallbackResult.result);
            }

            const completedFallback = updateSession(currentSession.id, {
              engineSessionId: fallbackResult.sessionId,
              status: fallbackResult.error ? "error" : "idle",
              lastActivity: new Date().toISOString(),
              lastError: fallbackResult.error ?? null,
            });
            if (completedFallback) {
              notifyParentSession(completedFallback, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }

            context.emit("session:completed", {
              sessionId: currentSession.id,
              employee: currentSession.employee || config.portal?.portalName || "Jinn",
              title: currentSession.title,
              result: fallbackResult.result,
              error: fallbackResult.error || null,
              cost: fallbackResult.cost,
              durationMs: fallbackResult.durationMs,
            });
          },
          onWaitingStart: ({ resumeAt }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;

            // Send hardcoded Discord notification — does not depend on the LLM
            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
            );

            const notificationText =
              `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`;
            insertMessage(currentSession.id, "notification", notificationText);

            // Notify parent session about rate limit (fire-and-forget)
            const waitingSession = getSession(currentSession.id);
            notifyRateLimited(
              (waitingSession ?? { ...currentSession, status: "waiting" }) as Session,
              resumeAt
                ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                : undefined,
            );

            context.emit("session:rate-limited", {
              sessionId: currentSession.id,
              employee: currentSession.employee,
              error: result.error,
              resetsAt: rateLimit.resetsAt ?? null,
            });
          },
          onRetryStream: emitDelta,
          onRetrySuccess: (retryResult) => {
            // Usage limit cleared — handle result
            if (retryResult.result) {
              insertMessage(currentSession.id, "assistant", retryResult.result);
            }

            const completedAfterRetry = updateSession(currentSession.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              ...(persistModel ? { model: resolvedModel } : {}),
              status: retryResult.error ? "error" : "idle",
              lastActivity: new Date().toISOString(),
              lastError: retryResult.error ?? null,
            });

            if (retryResult.cost || retryResult.numTurns) {
              accumulateSessionCost(
                currentSession.id,
                retryResult.cost ?? 0,
                retryResult.numTurns ?? 1,
              );
            }
            if (completedAfterRetry) {
              notifyRateLimitResumed(completedAfterRetry);
              notifyDiscordChannel(
                `✅ Claude usage limit cleared. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} resumed.`,
              );
              notifyParentSession(
                completedAfterRetry,
                { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs },
                { alwaysNotify: employee?.alwaysNotify },
              );
            }

            context.emit("session:completed", {
              sessionId: currentSession.id,
              employee: currentSession.employee || config.portal?.portalName || "Jinn",
              title: currentSession.title,
              result: retryResult.result,
              error: retryResult.error || null,
              cost: retryResult.cost,
              durationMs: retryResult.durationMs,
            });
          },
          onTimeout: () => {
            notifyDiscordChannel(
              `❌ Claude usage limit did not clear in time. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} has been stopped.`,
            );
            const erroredSession = updateSession(currentSession.id, {
              status: "error",
              lastActivity: new Date().toISOString(),
              lastError: "Claude usage limit did not clear in time",
            });
            if (erroredSession) {
              notifyParentSession(erroredSession, { error: "Claude usage limit did not clear in time" }, { alwaysNotify: employee?.alwaysNotify });
            }
            context.emit("session:completed", {
              sessionId: currentSession.id,
              result: null,
              error: "Claude usage limit did not clear in time",
            });
          },
        },
      });

      void outcome; // outcome handled entirely via hooks
      return;
    }

    // Persist the assistant response
    if (result.result) {
      insertMessage(currentSession.id, "assistant", result.result);
    }

    const completedSession = updateSession(currentSession.id, {
      ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
      ...(persistModel ? { model: resolvedModel } : {}),
      status: result.error ? "error" : "idle",
      lastActivity: new Date().toISOString(),
      lastError: result.error ?? null,
    });

    if (result.cost || result.numTurns) {
      accumulateSessionCost(
        currentSession.id,
        result.cost ?? 0,
        result.numTurns ?? 1,
      );
    }

    if (syncRequested && !rateLimit.limited && !wasInterrupted) {
      const meta = (getSession(currentSession.id)?.transportMeta || currentSession.transportMeta || {}) as Record<string, unknown>;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const nextMeta = { ...meta } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
        updateSession(currentSession.id, { transportMeta: nextMeta as any });
      }
    }
    // Notify parent session on child completion. Mirrors the connector path
    // in manager.ts:633-639: skip on user-initiated interrupt (the parent
    // wasn't waiting for a partial report), respect employee.alwaysNotify.
    if (completedSession && !wasInterrupted) {
      notifyParentSession(
        completedSession,
        { result: result.result, error: result.error ?? null, cost: result.cost, durationMs: result.durationMs },
        { alwaysNotify: employee?.alwaysNotify },
      );
    }

    context.emit("session:completed", {
      sessionId: currentSession.id,
      employee: currentSession.employee || config.portal?.portalName || "Jinn",
      title: currentSession.title,
      result: result.result,
      error: result.error || null,
      cost: result.cost,
      durationMs: result.durationMs,
    });

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    // Surface the failure to the parent — silent child errors caused a
    // multi-hour delegation stall in a prior incident.
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
    }
    context.emit("session:completed", {
      sessionId: currentSession.id,
      result: null,
      error: errMsg,
    });
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  }
}
