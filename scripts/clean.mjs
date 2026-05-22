#!/usr/bin/env node
// Cross-platform root-level clean: drops `.turbo` + `node_modules/.cache`.
// Replaces `rm -rf` which crashed Windows cmd. `turbo clean` (run after this)
// handles per-package dist folders via their own scripts.

import fs from "node:fs";
import path from "node:path";

const targets = [".turbo", path.join("node_modules", ".cache")];
for (const t of targets) {
  try {
    fs.rmSync(t, { recursive: true, force: true });
    console.log(`[clean] removed ${t}`);
  } catch (err) {
    if ((err && err.code) !== "ENOENT") console.warn(`[clean] could not remove ${t}: ${err.message}`);
  }
}
