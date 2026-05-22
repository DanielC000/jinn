import { logger } from "../shared/logger.js";
import {
  initDb,
  listOrganisations,
  listTasks,
  updateTask,
  createSession,
  findChildSessionByEmployeeAndTask,
  enqueueQueueItem,
} from "../sessions/registry.js";
import type { Task, Organisation } from "../shared/types.js";

/**
 * Phase 6 task auto-picker.
 *
 * Watches every Organisation's Kanban and dispatches tasks from To Do to the
 * configured lead employee within the WIP cap. The lead's session gets the
 * task prompt enqueued; everything past that flows through the regular web
 * session lifecycle (Phase 5's per-task uniqueness keeps re-dispatches idempotent).
 *
 * Running count = tasks where status IN ('in-progress', 'review'). Waiting
 * tasks don't count — parking on the human frees a WIP slot.
 *
 * Pre-dispatch wedge checks (skip + log; reschedule on the next tick):
 *   - lead's queue is paused (operator stop)
 *   - lead's current status is not idle/running
 *
 * The picker is intentionally polling-based (every 2s by default). The latency
 * is small enough that event-driven kicks aren't worth the wiring complexity.
 */

export interface TaskPickerOptions {
  /** Tick interval in ms. Defaults to 2000. */
  intervalMs?: number;
  /** Inject an event emitter so dispatches can be observed in tests. */
  emit?: (event: string, payload: unknown) => void;
  /** Inject a session-manager facade so the picker can enqueue prompts. */
  enqueuePrompt?: (sessionId: string, sessionKey: string, prompt: string) => void;
  /** Inject a queue-pause query so the picker can skip wedged leads. */
  isLeadPaused?: (sessionKey: string) => boolean;
}

export interface TaskPickerHandle {
  /** Stop the periodic tick. The next tick (if scheduled) does not fire. */
  stop: () => void;
  /** Trigger one immediate scan (useful after a task is promoted to To Do). */
  kick: () => Promise<void>;
}

function buildLeadPrompt(task: Task): string {
  return [
    `# Task #${task.id}: ${task.title}`,
    "",
    task.description || "(no description)",
    "",
    "The Kanban board has this task in In Progress. When you're done, signal completion by moving it to Review or Done. If you need user input mid-task, move it to Waiting. Delegate as needed; child sessions auto-bind to this task.",
  ].join("\n");
}

function isReachableLead(_org: Organisation): boolean {
  return !!_org.leadEmployeeId;
}

/**
 * Count tasks that currently consume a WIP slot for this Organisation.
 */
function runningCount(orgId: string): number {
  return listTasks({ organisationId: orgId }).filter((t) =>
    t.status === "in-progress" || t.status === "review"
  ).length;
}

/**
 * Pick the next dispatchable task from To Do, ordered by priority then age.
 */
function nextDispatchableTask(orgId: string): Task | undefined {
  const todos = listTasks({ organisationId: orgId, status: "todo" });
  const priorityRank: Record<string, number> = { high: 3, med: 2, low: 1 };
  todos.sort((a, b) => {
    const pa = priorityRank[a.priority] ?? 0;
    const pb = priorityRank[b.priority] ?? 0;
    if (pa !== pb) return pb - pa;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return todos[0];
}

/**
 * Dispatch one task to the Org's lead. Returns true when the dispatch
 * happened, false when skipped (e.g. wedged lead, no lead configured).
 */
function dispatchOne(org: Organisation, opts: Required<Pick<TaskPickerOptions, "emit" | "enqueuePrompt" | "isLeadPaused">>): boolean {
  if (!isReachableLead(org)) {
    logger.debug(`[picker] Organisation ${org.name} has no lead_employee_id; skipping`);
    return false;
  }

  const task = nextDispatchableTask(org.id);
  if (!task) return false;

  const leadName = org.leadEmployeeId!;

  // Per-task uniqueness: reuse if the lead already has a session for this task
  // (an operator may have started one manually before the picker got to it).
  let leadSession = findChildSessionByEmployeeAndTask(leadName, task.id);
  if (!leadSession) {
    const sessionKey = `web:task:${task.id}:${leadName}`;
    leadSession = createSession({
      engine: "claude",
      source: "web",
      sourceRef: sessionKey,
      connector: "web",
      sessionKey,
      employee: leadName,
      organisationId: org.id,
      taskId: task.id,
      replyContext: { source: "web", taskId: task.id },
    });
    logger.info(`[picker] Created lead session ${leadSession.id} for task ${task.id} (${task.title}) @ org ${org.name}`);
  }

  const sessionKey = leadSession.sessionKey || leadSession.sourceRef || leadSession.id;
  if (opts.isLeadPaused(sessionKey)) {
    logger.warn(`[picker] Lead session ${leadSession.id} is paused; skipping dispatch of task ${task.id}`);
    return false;
  }
  if (!["idle", "running"].includes(leadSession.status)) {
    logger.warn(`[picker] Lead session ${leadSession.id} has wedged status="${leadSession.status}"; skipping dispatch of task ${task.id}`);
    return false;
  }

  const prompt = buildLeadPrompt(task);
  enqueueQueueItem(leadSession.id, sessionKey, prompt);

  updateTask(task.id, { status: "in-progress", leadSessionId: leadSession.id });
  opts.emit("task:dispatched", { taskId: task.id, leadSessionId: leadSession.id, organisationId: org.id });
  opts.emit("queue:updated", { sessionId: leadSession.id, sessionKey });
  // Actually kick the session manager to drain the queue we just wrote to.
  // Without this, the queue_items row sits pending forever — session stays
  // idle, 0 messages. (Bug discovered 2026-05-22 on the first live picker run.)
  opts.enqueuePrompt(leadSession.id, sessionKey, prompt);
  logger.info(`[picker] Dispatched task ${task.id} to lead ${leadName} (org ${org.name})`);

  return true;
}

/**
 * Run one full scan across every Organisation, dispatching while each is
 * under its WIP cap.
 */
export function pickOnce(opts: TaskPickerOptions = {}): void {
  initDb();
  const orgs = listOrganisations();
  const emit = opts.emit ?? (() => {});
  const enqueuePrompt = opts.enqueuePrompt ?? (() => {});
  const isLeadPaused = opts.isLeadPaused ?? (() => false);
  for (const org of orgs) {
    let attempts = 0;
    while (runningCount(org.id) < org.wipCap && attempts < 50) {
      const dispatched = dispatchOne(org, { emit, enqueuePrompt, isLeadPaused });
      if (!dispatched) break; // No more dispatchable tasks (or every candidate wedged)
      attempts += 1;
    }
  }
}

/**
 * Start the periodic picker tick. Returns a handle to stop or kick it.
 */
export function startTaskPicker(opts: TaskPickerOptions = {}): TaskPickerHandle {
  const intervalMs = opts.intervalMs ?? 2000;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    try {
      pickOnce(opts);
    } catch (err) {
      logger.error(`[picker] tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(tick, intervalMs);
  return {
    stop: () => clearInterval(interval),
    kick: async () => tick(),
  };
}
