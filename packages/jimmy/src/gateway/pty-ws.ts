import type { WebSocket } from "ws";
import type { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { getSession } from "../sessions/registry.js";
import { JINN_HOME } from "../shared/paths.js";

/**
 * Attach a /ws/pty/:sessionId WebSocket to a session's interactive PTY stream.
 * - replays the scrollback buffer on connect
 * - streams live PTY output as binary frames
 * - accepts upstream {type:"stdin",data} and {type:"resize",cols,rows} JSON messages
 * - on close, just unsubscribes — it does NOT kill the PTY (the lifecycle manager owns that)
 */
export function attachPtyWebSocket(ws: WebSocket, sessionId: string, engine: InteractiveClaudeEngine): void {
  // Mark viewed on attach so the lifecycle grace window engages while the user is here.
  engine.markViewed(sessionId);

  // If there's no warm PTY for this session, spawn one (loads the conversation history
  // via `claude --resume`). We gate on hasWarmPty — NOT on scrollback emptiness —
  // because stale farewell bytes from a dead PTY persist in the scrollback buffer.
  if (!engine.hasWarmPty(sessionId)) {
    const session = getSession(sessionId);
    if (session?.engineSessionId) {
      engine.ensureIdleSpawn(sessionId, {
        claudeSessionId: session.engineSessionId,
        model: session.model ?? undefined,
        cwd: JINN_HOME,
      });
    }
  }

  // replay scrollback (may now include the idle-spawn's first bytes)
  const scrollback = engine.getScrollback(sessionId);
  if (scrollback.length > 0 && ws.readyState === ws.OPEN) ws.send(scrollback);

  // live output — engine yields Buffers already; forward as binary frames without re-encoding.
  // Control events (e.g. PTY respawn → `reset`) ride a JSON text frame so the client can
  // distinguish them from raw PTY bytes (which stay binary).
  const unsubscribe = engine.subscribeOutput(
    sessionId,
    (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    (event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    },
  );

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === "stdin" && typeof msg.data === "string") {
      engine.markViewed(sessionId);
      engine.writeStdin(sessionId, msg.data);
    } else if (msg?.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      engine.markViewed(sessionId);
      engine.resizePty(sessionId, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => { unsubscribe(); });
  ws.on("error", () => { unsubscribe(); });
}
