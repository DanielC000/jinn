// Fork-local: Windows PATH/PATHEXT resolution for node-pty spawns. Upstream is
// Unix-first and never hits this; defend the whole file + both callsites in
// claude-interactive.ts on every upstream sync.
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a bare executable name (e.g. "claude") to an absolute path by walking PATH.
 *
 * node-pty's Windows agent passes the bin to CreateProcess as `lpApplicationName`,
 * which does NOT search %PATH% — only the current dir and system dirs. So
 * `pty.spawn("claude", ...)` fails on Windows even when `claude.exe` is on PATH.
 * Node's own child_process.spawn has a hidden PATH-resolution layer; node-pty
 * doesn't. We replicate it here.
 *
 * Returns the input unchanged if it's already absolute or contains a path
 * separator (caller knew what they were doing), or if no candidate is found
 * (fall through to whatever error the spawner produces).
 */
const cache = new Map<string, string>();

export function resolveExecutable(name: string): string {
  if (!name) return name;
  if (path.isAbsolute(name)) return name;
  if (name.includes("/") || name.includes("\\")) return path.resolve(name);

  const cached = cache.get(name);
  if (cached) return cached;

  const PATH = process.env.PATH || process.env.Path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = PATH.split(sep).filter(Boolean);

  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  const hasExt = process.platform === "win32" && path.extname(name).length > 0;

  for (const dir of dirs) {
    if (hasExt) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        cache.set(name, candidate);
        return candidate;
      }
    } else {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (fs.existsSync(candidate)) {
          cache.set(name, candidate);
          return candidate;
        }
      }
    }
  }

  return name;
}
