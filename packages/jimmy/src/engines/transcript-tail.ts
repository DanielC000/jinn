import fs from "node:fs";
import type { StreamDelta } from "../shared/types.js";

/**
 * Parse one transcript JSONL line into StreamDeltas.
 * `priorSnapshot` is the accumulated assistant text so far; the returned
 * text_snapshot delta (if any) contains priorSnapshot + this line's text.
 */
export function parseTranscriptLine(line: string, priorSnapshot: string): StreamDelta[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return []; }

  const out: StreamDelta[] = [];
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return out;

  if (msg.type === "assistant") {
    let text = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "tool_use") {
        out.push({ type: "tool_use", content: `Using ${block.name ?? "tool"}`, toolName: String(block.name ?? "tool"), toolId: String(block.id ?? "") });
      }
    }
    if (text) {
      out.push({ type: "text", content: text });
      out.push({ type: "text_snapshot", content: priorSnapshot + text });
    }
  } else if (msg.type === "user") {
    for (const block of content) {
      if (block.type === "tool_result") out.push({ type: "tool_result", content: "" });
    }
  }
  return out;
}

export interface TranscriptTailer {
  stop(): void;
}

/** Tail a transcript file, emitting StreamDeltas for each appended line. */
export function tailTranscript(filePath: string, onDelta: (d: StreamDelta) => void): TranscriptTailer {
  let offset = 0;
  let snapshot = "";
  let buf = "";
  let stopped = false;

  const readNew = () => {
    if (stopped) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size <= offset) return;
    const fd = fs.openSync(filePath, "r");
    try {
      const chunk = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      offset = stat.size;
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        for (const d of parseTranscriptLine(l, snapshot)) {
          if (d.type === "text_snapshot") snapshot = d.content;
          onDelta(d);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  let watcher: fs.FSWatcher | undefined;
  try { watcher = fs.watch(filePath, () => readNew()); } catch { /* file may not exist yet */ }
  const poll = setInterval(readNew, 150); // 100ms batched writes — poll a bit slower
  if (poll.unref) poll.unref();
  readNew();

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
    },
  };
}
