import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths.js";
import type { JinnConfig } from "./types.js";

type ClaudeEngineConfig = JinnConfig["engines"]["claude"];

export function normalizeClaudeEngineConfig(raw: ClaudeEngineConfig): Required<Pick<ClaudeEngineConfig,
  "mode" | "idleTimeoutMs" | "graceWindowMs" | "turnTimeoutMs" | "maxLivePtys">> & ClaudeEngineConfig {
  const mode = raw.mode === "interactive" ? "interactive" : "headless";
  return {
    ...raw,
    mode,
    keepAlive: raw.keepAlive ?? false,
    idleTimeoutMs: raw.idleTimeoutMs ?? 1_800_000,
    graceWindowMs: raw.graceWindowMs ?? 300_000,
    turnTimeoutMs: raw.turnTimeoutMs ?? 600_000,
    maxLivePtys: raw.maxLivePtys ?? 8,
  };
}

export function loadConfig(): JinnConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Jinn config not found at ${CONFIG_PATH}. Run "jinn setup" first.`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = yaml.load(raw) as JinnConfig;
  config.engines.claude = normalizeClaudeEngineConfig(config.engines.claude);
  return config;
}
