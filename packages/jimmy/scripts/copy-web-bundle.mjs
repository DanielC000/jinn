import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const src = path.resolve(pkgRoot, "..", "web", "out");
const dest = path.join(pkgRoot, "dist", "web");

fs.rmSync(dest, { recursive: true, force: true });

if (!fs.existsSync(src)) {
  console.warn(`[copy-web-bundle] ${src} does not exist; skipping copy. Run \`pnpm --filter @jinn/web build\` first if you need the SPA bundled.`);
  process.exit(0);
}

fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-web-bundle] copied ${src} -> ${dest}`);
