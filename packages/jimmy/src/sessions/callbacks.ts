import { getSession } from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";

/**
 * Notify the parent session that a child session has replied.
 * Sends an internal message to the parent via the local HTTP API.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): void {
  if (!childSession.parentSessionId) return;
  if (options?.alwaysNotify === false) return;

  // Run asynchronously — do not await in the caller
  _sendNotification(childSession, result).catch((err) => {
    logger.warn(`[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a child session has been rate-limited and will auto-resume.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimited(
  childSession: Session,
  estimatedResumeTime?: string, // ISO timestamp or human-readable
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, {
    error: null,
    result: `⏳ Session is rate-limited and will auto-resume${estimatedResumeTime ? ` around ${estimatedResumeTime}` : ' when the limit resets'}. No action needed.`,
  }).catch((err) => {
    logger.warn(`[callbacks] Failed to send rate-limit notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a rate-limited child session has successfully resumed.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimitResumed(
  childSession: Session,
): void {
  if (!childSession.parentSessionId) return;

  const employeeName = childSession.employee || "Unknown";
  _sendRaw(childSession.parentSessionId, `🔄 Employee "${employeeName}" (session ${childSession.id}) has resumed after rate limit cleared.`).catch((err) => {
    logger.warn(`[callbacks] Failed to send resume notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) return; // Parent gone or expired
  if (parent.status === "error") return; // Parent already in error — skip

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  // Dual audience: `message` is what the parent ENGINE (e.g. the COO) reads —
  // it carries full context and the API hints it needs to follow up.
  // `displayMessage` is the clean, human-facing version shown in the web UI
  // notification banner.
  let message: string;
  let displayMessage: string;
  if (result.error) {
    message = `⚠️ Employee "${employeeName}" (child session ${childId}) hit an error and could not finish: ${result.error}`;
    displayMessage = `⚠️ ${employeeName} couldn't finish`;
  } else {
    const raw = (result.result || "").trim() || "(no output)";
    const llmPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
    message =
      `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
      `Reply preview:\n${llmPreview}\n\n` +
      `To read the full reply: GET /api/sessions/${childId}?last=N · ` +
      `to follow up: POST /api/sessions/${childId}/message`;
    displayMessage = `📩 ${employeeName} replied\n${_clean(raw, 220)}`;
  }

  await _sendRaw(childSession.parentSessionId!, message, displayMessage);
}

/** Trim to a word boundary for a tidy human-facing preview. */
function _clean(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Send a hardcoded notification to the configured Discord channel.
 * Used for rate-limit alerts that must not depend on the LLM.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyDiscordChannel(message: string): void {
  _sendDiscordNotification(message).catch((err) => {
    logger.warn(`[callbacks] Failed to send Discord notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendDiscordNotification(message: string): Promise<void> {
  let port = 7777;
  let connector = "discord";
  let channel: string | undefined;

  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
    connector = config.notifications?.connector || "discord";
    channel = config.notifications?.channel;
  } catch {
    // Use defaults if config is unavailable
  }

  if (!channel) {
    logger.debug("[callbacks] No notifications.channel configured — skipping Discord notification");
    return;
  }

  await fetch(`http://127.0.0.1:${port}/api/connectors/${connector}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text: message }),
  });
}

async function _sendRaw(
  parentSessionId: string,
  message: string,
  displayMessage?: string,
): Promise<void> {
  let port = 7777;
  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
  } catch {
    // Use default port if config is unavailable
  }

  await fetch(`http://127.0.0.1:${port}/api/sessions/${parentSessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      role: "notification",
      ...(displayMessage ? { displayMessage } : {}),
    }),
  });
}
