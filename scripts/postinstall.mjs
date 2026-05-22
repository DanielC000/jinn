#!/usr/bin/env node
// Cross-platform postinstall: chmod node-pty's spawn-helper on Unix; no-op on Windows.
// The original inline bash command (`chmod ... || true`) crashed cmd.exe with
// "Der Befehl true ist entweder falsch geschrieben oder konnte nicht gefunden werden"
// because Windows cmd doesn't have `true` and chains `||` differently.

import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  process.exit(0); // Nothing to do — Windows doesn't use the spawn-helper shim.
}

const root = path.join(process.cwd(), "node_modules", ".pnpm");
let touched = 0;

try {
  const pnpmDirs = fs.readdirSync(root, { withFileTypes: true });
  for (const d of pnpmDirs) {
    if (!d.isDirectory() || !d.name.startsWith("node-pty@")) continue;
    const prebuilds = path.join(root, d.name, "node_modules", "node-pty", "prebuilds");
    let archs;
    try { archs = fs.readdirSync(prebuilds, { withFileTypes: true }); } catch { continue; }
    for (const a of archs) {
      if (!a.isDirectory()) continue;
      const helper = path.join(prebuilds, a.name, "spawn-helper");
      try {
        fs.chmodSync(helper, 0o755);
        touched += 1;
      } catch { /* helper missing for this arch — ignore */ }
    }
  }
} catch { /* node_modules/.pnpm absent (fresh clone before install) — ignore */ }

if (touched > 0) console.log(`[postinstall] chmod +x ${touched} node-pty spawn-helper(s)`);
