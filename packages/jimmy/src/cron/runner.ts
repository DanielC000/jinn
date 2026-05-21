import type { CronJob, Connector, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  createTask,
  enqueueQueueItem,
  getTask,
  insertMessage,
  listOrganisations,
  listTasks,
  getSession,
} from "../sessions/registry.js";

/**
 * Phase 8b: handle the two non-untracked cron task modes.
 *
 *   - create-task : file a fresh task in Backlog (default) or To Do (per
 *                   job config) for the Org, then stop. Picker takes it from
 *                   there. Rejected when the Org is already at WIP cap.
 *   - resume-task : dispatch the prompt to taskId's lead session as a new
 *                   user turn. Rejected when the task isn't open.
 */
async function runCronTaskMode(
  job: CronJob,
  taskMode: "create-task" | "resume-task",
  _config: JinnConfig,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const sessionKey = `cron:${job.id}:${Date.now()}`;

  // Resolve the Organisation. Either explicit on the job, or fall back to first.
  const orgId = job.organisationId ?? listOrganisations()[0]?.id ?? null;
  if (!orgId) {
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: "No Organisation available for taskMode=" + taskMode,
      resultPreview: null,
    });
    logger.error(`Cron job "${job.name}": no Organisation; skipping`);
    return;
  }

  if (taskMode === "create-task") {
    // Reject when the Org is at WIP cap. The picker would otherwise sit on this
    // card; better to skip + log than silently accumulate backlog.
    const cap = listOrganisations().find((o) => o.id === orgId)?.wipCap ?? 3;
    const running = listTasks({ organisationId: orgId }).filter((t) => t.status === "in-progress" || t.status === "review").length;
    if (running >= cap) {
      appendRunLog(job.id, {
        timestamp: startedAt,
        sessionKey,
        status: "skipped",
        durationMs: Date.now() - startTime,
        error: `Organisation at WIP cap (${running}/${cap}); not creating task`,
        resultPreview: null,
      });
      logger.warn(`Cron job "${job.name}" skipped: Org ${orgId} at WIP cap ${running}/${cap}`);
      return;
    }
    const task = createTask({
      organisationId: orgId,
      title: job.name,
      description: job.prompt,
      priority: "med",
      status: "backlog",
    });
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "success",
      durationMs: Date.now() - startTime,
      error: null,
      resultPreview: `Created task ${task.id}`,
    });
    logger.info(`Cron job "${job.name}" filed task ${task.id} in Org ${orgId}`);
    return;
  }

  // resume-task: enqueue the prompt onto taskId's lead session.
  const taskId = job.taskId;
  if (!taskId) {
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: "taskMode=resume-task requires taskId",
      resultPreview: null,
    });
    return;
  }
  const task = getTask(taskId);
  if (!task || task.status === "done" || !task.leadSessionId) {
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "skipped",
      durationMs: Date.now() - startTime,
      error: `Task ${taskId} is not open or has no lead session; skipping`,
      resultPreview: null,
    });
    return;
  }
  const lead = getSession(task.leadSessionId);
  if (!lead) return;
  insertMessage(lead.id, "user", job.prompt);
  enqueueQueueItem(lead.id, lead.sessionKey || lead.sourceRef || lead.id, job.prompt);
  appendRunLog(job.id, {
    timestamp: startedAt,
    sessionKey,
    status: "success",
    durationMs: Date.now() - startTime,
    error: null,
    resultPreview: `Resumed task ${task.id} via lead session ${lead.id}`,
  });
  logger.info(`Cron job "${job.name}" resumed task ${task.id}`);
}

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting (taskMode=${job.taskMode ?? "untracked"})`);

  // Phase 8b: dispatch by taskMode. Default 'untracked' falls through to
  // today's session-routing path below.
  const taskMode = job.taskMode ?? "untracked";
  if (taskMode === "create-task" || taskMode === "resume-task") {
    await runCronTaskMode(job, taskMode, config);
    return;
  }

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const cooSlug = config.portal?.portalName?.toLowerCase() || "jinn";
  if (delivery && job.employee && job.employee !== cooSlug) {
    logger.debug(
      `Cron job "${job.name}" targets employee "${job.employee}" directly (skipping COO delegation).`,
    );
  }

  let employee;
  if (job.employee) {
    const orgRegistry = scanOrg();
    employee = findEmployee(job.employee, orgRegistry);
  }

  const connector = new CronConnector(connectors, delivery);
  const startedAt = new Date().toISOString();
  const sessionKey = `cron:${job.id}:${Date.now()}`;

  try {
    const routeResult = await sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey,
        replyContext: {
          channel: delivery?.channel || job.id,
          messageTs: null,
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
        },
        messageId: undefined,
        channel: delivery?.channel || job.id,
        thread: undefined,
        user: "system",
        userId: "system",
        text: job.prompt,
        attachments: [],
        raw: { jobId: job.id, trigger: "cron" },
        transportMeta: {
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
          deliveryChannel: delivery?.channel ?? null,
        },
      },
      connector,
      {
        employee,
        engine: job.engine || employee?.engine || config.engines.default,
        model: job.model || employee?.model || config.engines[(job.engine || config.engines.default) as "claude" | "codex" | "gemini"]?.model,
        title: job.name,
      },
    );

    const durationMs = Date.now() - startTime;
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: routeResult?.sessionId ?? null,
      status: "success",
      durationMs,
      error: null,
      resultPreview: null,
    });
    logger.info(`Cron job "${job.name}" completed in ${durationMs}ms`);

    // Latency alert: warn if job exceeded threshold
    const thresholdMs = config.cron?.alertThresholdMs;
    if (thresholdMs && durationMs > thresholdMs) {
      const alertConnector = config.cron?.alertConnector;
      const alertChannel = config.cron?.alertChannel;
      if (alertConnector && alertChannel) {
        const alertTarget = connectors.get(alertConnector);
        if (alertTarget) {
          const mins = (durationMs / 60_000).toFixed(1);
          const threshMins = (thresholdMs / 60_000).toFixed(1);
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `🐢 Cron latency alert: "${job.name}" (${job.id}) exceeded threshold — took ${mins}min (threshold: ${threshMins}min). Session: ${routeResult?.sessionId ?? "unknown"}`,
          ).catch((alertErr) => {
            logger.error(`Failed to send latency alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: message,
      resultPreview: null,
    });
    logger.error(`Cron job "${job.name}" failed: ${message}`);

    // Send alert if configured
    const alertConnector = config.cron?.alertConnector;
    const alertChannel = config.cron?.alertChannel;
    if (alertConnector && alertChannel) {
      const alertTarget = connectors.get(alertConnector);
      if (alertTarget) {
        await alertTarget.sendMessage(
          { channel: alertChannel },
          `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
        ).catch((alertErr) => {
          logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
        });
      }
    }
  }
}
