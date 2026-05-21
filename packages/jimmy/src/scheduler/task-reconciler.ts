import { logger } from "../shared/logger.js";
import {
  getSession,
  listOrganisations,
  listTasks,
  updateTask,
} from "../sessions/registry.js";

/**
 * Phase 6 reconciler.
 *
 * Pure event-driven scheduling rots: the lead session can wedge (paused,
 * interrupted, errored, crashed, or size-auto-archived for an untracked
 * sibling) and no task:* event will fire to free the slot. The reconciler
 * polls every 60s per Organisation and marks broken tasks 'stalled' so the
 * UI surfaces them with a re-dispatch banner.
 *
 * Stalled tasks can be:
 *   - PATCH /api/tasks/:id { status: "todo" } (re-dispatch — picker grabs it)
 *   - POST /api/tasks/:id/close (close-as-failed)
 */

export interface TaskReconcilerOptions {
  intervalMs?: number;
  emit?: (event: string, payload: unknown) => void;
}

export interface TaskReconcilerHandle {
  stop: () => void;
  /** Run one immediate reconciliation pass. */
  kick: () => void;
}

const NON_TERMINAL: Array<"in-progress" | "waiting" | "review"> = ["in-progress", "waiting", "review"];

function reconcileOne(orgId: string, emit: (event: string, payload: unknown) => void): void {
  for (const status of NON_TERMINAL) {
    for (const task of listTasks({ organisationId: orgId, status })) {
      let stalled: string | null = null;
      if (!task.leadSessionId) {
        stalled = "lead_session_id is null";
      } else {
        const lead = getSession(task.leadSessionId);
        if (!lead) stalled = "lead session row missing";
        else if (lead.status === "error") stalled = `lead session in error: ${lead.lastError ?? "unknown"}`;
        else if (lead.status === "archived") stalled = "lead session was archived";
      }
      if (stalled) {
        logger.warn(`[reconciler] Task ${task.id} (${task.title}) stalled: ${stalled}`);
        updateTask(task.id, { status: "stalled" });
        emit("task:stalled", { taskId: task.id, reason: stalled });
      }
    }
  }
}

export function reconcileOnce(opts: TaskReconcilerOptions = {}): void {
  const emit = opts.emit ?? (() => {});
  const orgs = listOrganisations();
  for (const org of orgs) reconcileOne(org.id, emit);
}

export function startTaskReconciler(opts: TaskReconcilerOptions = {}): TaskReconcilerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    try {
      reconcileOnce(opts);
    } catch (err) {
      logger.error(`[reconciler] tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(tick, intervalMs);
  return {
    stop: () => clearInterval(interval),
    kick: tick,
  };
}
