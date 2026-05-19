/**
 * Read Claude Code session transcripts off disk.
 *
 * Claude Code stores conversations as JSONL files at
 *   ~/.claude/projects/<cwd-key>/<engineSessionId>.jsonl
 *
 * We don't recompute the cwd-key (Claude's transform differs from what we'd
 * derive from `cwd`), we just walk the projects dir and look for the file.
 */
import fs from "node:fs";
import path from "node:path";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Resolve the absolute path to ~/.claude/projects, honoring both POSIX and
 * Windows home-dir env vars. Returns null if neither is set or the dir
 * doesn't exist.
 */
function claudeProjectsDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return null;
  const dir = path.join(home, ".claude", "projects");
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Walk ~/.claude/projects/* looking for `<engineSessionId>.jsonl`. Returns
 * its absolute path or null if not found.
 */
export function findTranscriptPath(engineSessionId: string): string | null {
  const projectsDir = claudeProjectsDir();
  if (!projectsDir) return null;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(projectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) return jsonlPath;
  }
  return null;
}

/**
 * Load user + assistant text from a Claude transcript jsonl, dropping
 * tool calls/results, thinking blocks, and any other non-text frames.
 *
 * Returns an empty array if the file isn't found or is unreadable.
 */
export function loadTranscriptMessages(engineSessionId: string): TranscriptMessage[] {
  const jsonlPath = findTranscriptPath(engineSessionId);
  if (!jsonlPath) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];
  const lines = raw.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const type = obj.type;
      if (type !== "user" && type !== "assistant") continue;
      const msg = obj.message;
      if (!msg) continue;

      let content = msg.content;
      if (Array.isArray(content)) {
        content = content
          .filter((b: Record<string, unknown>) => b.type === "text")
          .map((b: Record<string, unknown>) => b.text)
          .join("");
      }
      if (typeof content === "string" && content.trim()) {
        messages.push({ role: type, content: content.trim() });
      }
    } catch {
      continue;
    }
  }
  return messages;
}
