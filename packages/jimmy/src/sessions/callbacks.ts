import { getSession } from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";

/**
 * Fork-local: notify the parent session that a child session has replied.
 *
 * Upstream commit 24ab541 (2026-05-19, "refactor(web): mobile-first chat shell +
 * nuke notifications") deleted this end-to-end. We restore the minimum needed for
 * autonomous agent delegation: child completion → message injected into the parent
 * → parent re-runs and chains next steps. The original system also delivered to
 * Slack/Telegram and rendered a NotificationBell — we explicitly do not restore
 * those; web-only.
 *
 * Posts as role='notification' so the gateway:
 *   1. Persists the message with role='notification' (UI renders as a system
 *      banner, not a user bubble).
 *   2. NEVER interrupts a running parent turn — queues behind. Critical when
 *      multiple children finish near-simultaneously and the parent is mid-processing
 *      an earlier sibling's reply (the load-bearing reason we use this role).
 *
 * Fire-and-forget — errors are logged but never rethrown.
 *
 * DO NOT remove on the next upstream sync — upstream isn't bringing this back.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null },
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, result).catch((err) => {
    logger.warn(
      `[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null },
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) return;
  if (parent.status === "error") return;

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  let message: string;
  if (result.error) {
    message = `⚠️ Employee "${employeeName}" (session ${childId}) encountered an error: ${result.error}`;
  } else {
    const raw = result.result || "(no output)";
    const preview = raw.length > 200 ? raw.substring(0, 200) + "..." : raw;
    message = `📩 Employee "${employeeName}" replied in session ${childId}.\nRead the latest messages: GET /api/sessions/${childId}?last=N\n\nPreview: ${preview}`;
  }

  let port = 7777;
  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
  } catch {
    // Use default port if config is unavailable
  }

  await fetch(`http://127.0.0.1:${port}/api/sessions/${childSession.parentSessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, role: "notification" }),
  });
}
