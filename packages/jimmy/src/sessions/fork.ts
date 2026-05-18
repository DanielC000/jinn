/**
 * Engine-specific session forking logic for the Duplicate feature.
 *
 * - Claude: uses --fork-session flag with --print mode
 * - Codex: copies the JSONL session file with a new UUID
 * - Gemini: copies the JSON session file with a new UUID
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as pty from "node-pty";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../shared/logger.js";
import type { InteractiveClaudeEngine } from "../engines/claude-interactive.js";

export interface ForkResult {
  engineSessionId: string;
}

/**
 * Optional interactive context for forking. When provided, the source session's
 * warm PTY is released first, and the fork itself is spawned in a PTY (no `-p`)
 * so the new turn bills as `cc_entrypoint=cli` rather than the Agent-SDK
 * headless pool.
 */
export interface InteractiveForkCtx {
  /** Jinn session id of the SOURCE session — used to release its warm PTY before forking. */
  sourceJinnSessionId: string;
  /** The interactive engine — used to release the source PTY. */
  engine: InteractiveClaudeEngine;
  /** claude binary path (defaults to "claude"). */
  bin?: string;
}

export interface ForkClaudeOpts {
  engineSessionId: string;
  cwd: string;
  /** When set, the fork uses interactive (no -p) and releases the source PTY first. */
  interactive?: InteractiveForkCtx;
}

/**
 * Fork a Claude Code CLI session using --fork-session.
 * Returns the new engine session ID from the fork.
 *
 * - Headless mode (default): runs `claude --resume <id> --fork-session --print -p ...`
 *   via execFileSync. Bills against the Agent-SDK credit pool.
 * - Interactive mode (when `opts.interactive` is set): releases the source PTY
 *   first, then spawns `claude --resume <id> --fork-session "<prompt>"` in a PTY
 *   (no `-p`) and polls the project's transcript directory for the new jsonl to
 *   discover the new session id. Bills as `cc_entrypoint=cli`.
 */
export function forkClaudeSession(opts: ForkClaudeOpts): ForkResult {
  const { engineSessionId, cwd, interactive } = opts;

  if (interactive) {
    return forkClaudeSessionInteractive(engineSessionId, cwd, interactive);
  }

  logger.info(`Forking Claude session ${engineSessionId} in ${cwd} (headless)`);

  const result = execFileSync("claude", [
    "--resume", engineSessionId,
    "--fork-session",
    "--print",
    "--output-format", "json",
    "-p", "Session duplicated — this is a snapshot of the original conversation.",
  ], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, PATH: process.env.PATH },
  });

  const lastLine = result.trim().split("\n").pop();
  if (!lastLine) throw new Error("Claude fork returned empty output");
  const parsed = JSON.parse(lastLine) as { session_id?: string };
  if (!parsed.session_id) {
    throw new Error("Claude fork did not return a session_id");
  }

  logger.info(`Claude fork successful: ${engineSessionId} → ${parsed.session_id}`);
  return { engineSessionId: parsed.session_id };
}

/**
 * Interactive-mode fork: release the source PTY, spawn `claude --fork-session`
 * in a PTY (no `-p`), discover the new session id via transcript-dir polling,
 * then kill the spawn. Bills as `cc_entrypoint=cli`.
 */
function forkClaudeSessionInteractive(
  engineSessionId: string,
  cwd: string,
  ctx: InteractiveForkCtx,
): ForkResult {
  logger.info(`Forking Claude session ${engineSessionId} in ${cwd} (interactive)`);

  // 1. Release the source PTY (best-effort — safe when nothing is warm).
  try {
    ctx.engine.kill(ctx.sourceJinnSessionId, "Interrupted: forking");
  } catch (err) {
    logger.warn(`Interactive fork: failed to release source PTY for ${ctx.sourceJinnSessionId}: ${(err as Error).message}`);
  }

  // Tiny settle delay so the transcript lock from the previous process is gone
  // before we spawn the fork. Synchronous busy-wait to keep the fork API sync.
  const settleUntil = Date.now() + 150;
  // eslint-disable-next-line no-empty
  while (Date.now() < settleUntil) {}

  const projectDir = claudeProjectDir(cwd);
  const spawnedAfter = Date.now();

  const bin = ctx.bin || "claude";
  const args = [
    "--resume", engineSessionId,
    "--fork-session",
    "Session duplicated — this is a snapshot of the original conversation.",
  ];

  // Clean env: drop CLAUDE_CODE_* / CLAUDECODE inherited from gateway, add NO_FLICKER.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (v !== undefined) env[k] = v;
  }
  env.CLAUDE_CODE_NO_FLICKER = "1";

  logger.info(`Interactive fork: spawning ${bin} ${args.join(" ")}`);
  const proc = pty.spawn(bin, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env,
  });

  let newSessionId: string | null = null;
  try {
    newSessionId = findNewJsonlSinceSync(projectDir, spawnedAfter, 60_000);
  } finally {
    // Always kill the interactive TUI — it doesn't exit on its own after the
    // one-turn fork-prompt is submitted.
    try { proc.kill(); } catch { /* already gone */ }
  }

  if (!newSessionId) {
    throw new Error(`Interactive fork: timed out waiting for new transcript in ${projectDir}`);
  }

  logger.info(`Claude interactive fork successful: ${engineSessionId} → ${newSessionId}`);
  return { engineSessionId: newSessionId };
}

/** Translate a cwd into the Claude project directory key (`/` → `-`). */
function claudeProjectDir(cwd: string): string {
  const key = cwd.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", key);
}

/**
 * Poll a Claude project transcript directory for a new `.jsonl` file whose
 * mtime is after `sinceMs`. Returns the basename without `.jsonl` (the session
 * id) or `null` on timeout. Synchronous polling with 250ms beats.
 */
function findNewJsonlSinceSync(projectDir: string, sinceMs: number, timeoutMs: number): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(projectDir)) {
      try {
        const entries = fs.readdirSync(projectDir);
        for (const name of entries) {
          if (!name.endsWith(".jsonl")) continue;
          const full = path.join(projectDir, name);
          let st: fs.Stats;
          try { st = fs.statSync(full); } catch { continue; }
          // Use birthtime if available, else mtime — either being after sinceMs
          // indicates a new transcript file created by the fork.
          const birth = st.birthtimeMs || 0;
          const mtime = st.mtimeMs || 0;
          if (birth >= sinceMs || mtime >= sinceMs) {
            // Heuristic safety: require the file is non-empty (Claude writes
            // at least the summary/init lines almost immediately).
            if (st.size > 0) {
              return name.slice(0, -".jsonl".length);
            }
          }
        }
      } catch { /* keep polling */ }
    }
    // Synchronous 250ms sleep via Atomics.wait on a SharedArrayBuffer would be
    // cleaner, but a tiny busy-loop using a sync child of `false` is overkill.
    // execFileSync of `sleep` works on darwin/linux and keeps this function sync.
    const sleepUntil = Date.now() + 250;
    // eslint-disable-next-line no-empty
    while (Date.now() < sleepUntil) {}
  }
  return null;
}

/**
 * Fork a Codex CLI session by copying its JSONL file with a new UUID.
 * Returns the new engine session ID.
 */
export function forkCodexSession(engineSessionId: string): ForkResult {
  logger.info(`Forking Codex session ${engineSessionId}`);

  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const sourceFile = findCodexSessionFile(sessionsRoot, engineSessionId);
  if (!sourceFile) {
    throw new Error(`Codex session file not found for ${engineSessionId}`);
  }

  const newUuid = uuidv4();
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const destDir = path.join(sessionsRoot, year, month, day);
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `rollout-${ts}-${newUuid}.jsonl`);

  // Read source, rewrite session_meta (first line) with new UUID
  const lines = fs.readFileSync(sourceFile, "utf-8").split("\n");
  if (lines.length > 0 && lines[0].trim()) {
    const meta = JSON.parse(lines[0]);
    if (meta.payload?.id) {
      meta.payload.id = newUuid;
      meta.timestamp = now.toISOString();
      lines[0] = JSON.stringify(meta);
    }
  }

  fs.writeFileSync(destFile, lines.join("\n"));
  logger.info(`Codex fork successful: ${engineSessionId} → ${newUuid} (${destFile})`);
  return { engineSessionId: newUuid };
}

/**
 * Fork a Gemini CLI session by copying its JSON file with a new UUID.
 * Returns the new engine session ID.
 */
export function forkGeminiSession(engineSessionId: string): ForkResult {
  logger.info(`Forking Gemini session ${engineSessionId}`);

  const geminiTmp = path.join(os.homedir(), ".gemini", "tmp");
  const sourceFile = findGeminiSessionFile(geminiTmp, engineSessionId);
  if (!sourceFile) {
    throw new Error(`Gemini session file not found for ${engineSessionId}`);
  }

  const data = JSON.parse(fs.readFileSync(sourceFile, "utf-8"));
  const newUuid = uuidv4();
  const now = new Date();
  const ts = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}-${String(now.getUTCMinutes()).padStart(2, "0")}`;

  // Update session ID and message IDs
  data.sessionId = newUuid;
  data.startTime = now.toISOString();
  data.lastUpdated = now.toISOString();
  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (msg.id) msg.id = uuidv4();
    }
  }

  // Write to same chats directory as the source
  const chatsDir = path.dirname(sourceFile);
  const destFile = path.join(chatsDir, `session-${ts}-${newUuid.slice(0, 8)}.json`);
  fs.writeFileSync(destFile, JSON.stringify(data, null, 2));

  logger.info(`Gemini fork successful: ${engineSessionId} → ${newUuid} (${destFile})`);
  return { engineSessionId: newUuid };
}

/**
 * Fork an engine session based on engine type.
 *
 * For Claude, the optional `interactive` ctx routes the fork through a PTY
 * (no `-p`) so it bills as `cc_entrypoint=cli`. Codex/Gemini ignore it.
 */
export function forkEngineSession(
  engine: string,
  engineSessionId: string,
  cwd: string,
  interactive?: InteractiveForkCtx,
): ForkResult {
  switch (engine) {
    case "claude":
      return forkClaudeSession({ engineSessionId, cwd, interactive });
    case "codex":
      return forkCodexSession(engineSessionId);
    case "gemini":
      return forkGeminiSession(engineSessionId);
    default:
      throw new Error(`Unsupported engine for fork: ${engine}`);
  }
}

// --- Helpers ---

function findCodexSessionFile(root: string, sessionId: string): string | null {
  // Codex filenames contain the UUID: rollout-<ts>-<uuid>.jsonl
  // Walk year/month/day directories
  if (!fs.existsSync(root)) return null;
  for (const year of fs.readdirSync(root)) {
    const yearDir = path.join(root, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      for (const day of fs.readdirSync(monthDir)) {
        const dayDir = path.join(monthDir, day);
        if (!fs.statSync(dayDir).isDirectory()) continue;
        for (const file of fs.readdirSync(dayDir)) {
          if (file.endsWith(".jsonl") && file.includes(sessionId)) {
            return path.join(dayDir, file);
          }
        }
      }
    }
  }
  return null;
}

function findGeminiSessionFile(tmpRoot: string, sessionId: string): string | null {
  // Gemini sessions: ~/.gemini/tmp/<project-hash>/chats/session-<ts>-<id-prefix>.json
  // The filename only has the first 8 chars of the UUID, so we need to read the JSON to match
  if (!fs.existsSync(tmpRoot)) return null;
  const prefix = sessionId.slice(0, 8);
  for (const projHash of fs.readdirSync(tmpRoot)) {
    const chatsDir = path.join(tmpRoot, projHash, "chats");
    if (!fs.existsSync(chatsDir) || !fs.statSync(chatsDir).isDirectory()) continue;
    for (const file of fs.readdirSync(chatsDir)) {
      if (!file.endsWith(".json")) continue;
      // Quick check: filename contains the UUID prefix
      if (file.includes(prefix)) {
        const filePath = path.join(chatsDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (data.sessionId === sessionId) return filePath;
        } catch { /* skip corrupted files */ }
      }
    }
  }
  return null;
}
