import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function getPtyWsUrl(sessionId: string): string {
  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (gatewayUrl) {
    return `${gatewayUrl.replace(/^http/, "ws")}/ws/pty/${sessionId}`;
  }
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/pty/${sessionId}`;
  }
  return `ws://127.0.0.1:7777/ws/pty/${sessionId}`;
}

/**
 * Live xterm.js view onto a session's interactive `claude` PTY, served over /ws/pty/:sessionId.
 *
 * Two important UX rules:
 *  - We refuse to open the WS unless `sessionId` is a real, non-empty string. Opening
 *    `/ws/pty/null` would attach to a non-existent stream and the terminal would stay
 *    blank forever.
 *  - The overlay textarea does NOT send via WS stdin by default. If a warm PTY hasn't
 *    been spawned yet (no turn has run), `writeStdin` is a silent no-op on the daemon.
 *    Instead the parent passes `onSend` (= the regular HTTP message-send) so the first
 *    turn spawns the PTY; its output then streams back through this same WebSocket.
 *    If no `onSend` is wired, we fall back to WS stdin and log a warning.
 */
export function CliTerminal({
  sessionId,
  onSend,
}: {
  sessionId: string;
  onSend?: (text: string) => void | Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [hasOutput, setHasOutput] = useState(false);
  // Mirror of `hasOutput` for use inside the WS onmessage closure, which is
  // created once per session and would otherwise see a stale `false`.
  const hasOutputRef = useRef(false);
  // A reset frame can flip hasOutput back to false; keep the ref in sync.
  const markHasOutput = (value: boolean) => {
    hasOutputRef.current = value;
    setHasOutput(value);
  };

  useEffect(() => {
    // Defensive guard — parent already gates rendering on sessionId, but if a falsy
    // value ever slips through, do nothing rather than open /ws/pty/null.
    if (!sessionId) return;
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: "#0b0b0c" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const wsUrl = getPtyWsUrl(sessionId);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (e) => {
      // Text frames carry JSON control messages from the daemon. The PTY
      // can respawn within the same session (e.g. KEEP ALIVE → daemon
      // restarts claude); when it does, the daemon emits {"type":"reset"}
      // so we can clear the previous PTY's scrollback before new bytes
      // arrive on the (binary) data path. Data is always binary.
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === "reset") {
            term.reset();
            markHasOutput(false);
            return;
          }
        } catch {
          // Not JSON — fall through and treat as plain text output.
        }
        term.write(e.data);
        if (!hasOutputRef.current && e.data.length > 0) markHasOutput(true);
      } else {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        term.write(bytes);
        if (!hasOutputRef.current && bytes.byteLength > 0) markHasOutput(true);
      }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    // Coalesce a burst of `resize` events (window drag, mobile rotation,
    // devtools open) into one fit + one WS frame per animation frame. Without
    // this, fit.fit() and a WS resize message fire per pixel during a drag.
    let raf: number | null = null;
    const onResize = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (raf !== null) cancelAnimationFrame(raf);
      ws.close();
      wsRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  const handleOverlaySend = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (onSend) {
      // Route through the normal HTTP send path — this spawns the PTY for the first
      // turn (or injects into the warm PTY on subsequent turns), and its output
      // streams back through this WebSocket into xterm naturally.
      void onSend(text);
      return;
    }
    // Fallback: write raw to the PTY via WS stdin. This only works once a warm PTY
    // exists; before the first turn the daemon silently drops it.
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.warn(
        "[CliTerminal] onSend prop not provided — falling back to WS stdin. " +
          "If no turn has run yet, this message will be silently dropped by the daemon."
      );
      ws.send(JSON.stringify({ type: "stdin", data: text }));
    }
  };

  if (!sessionId) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#888",
          fontFamily: "monospace",
          fontSize: 13,
          padding: "1rem",
          textAlign: "center",
        }}
      >
        Send your first message to start the interactive session.
      </div>
    );
  }

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <div ref={containerRef} style={{ height: "100%" }} />
      {!hasOutput && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            padding: "1rem",
            color: "#888",
            fontFamily: "monospace",
            fontSize: 12,
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          Waiting for the interactive claude PTY… send a message below (or in Chat) to spawn it.
        </div>
      )}
      <CliOverlayInput onSend={handleOverlaySend} />
    </div>
  );
}

function CliOverlayInput({ onSend }: { onSend: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <textarea
      ref={ref}
      placeholder="Type a message…"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (ref.current) {
            onSend(ref.current.value);
            ref.current.value = "";
          }
        }
      }}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: "5.5rem",
        background: "#0b0b0c",
        color: "#eee",
        border: "1px solid #333",
        padding: "0.5rem",
        fontFamily: "monospace",
        resize: "none",
      }}
    />
  );
}
