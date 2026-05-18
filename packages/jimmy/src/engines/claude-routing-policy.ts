/**
 * Pure routing decision for the Claude engine wrapper.
 *
 * Returns "interactive" only when the caller explicitly opts in via
 * claudeVariant === "interactive". Everything else (including web with no
 * explicit variant and cron/connectors) falls through to headless `claude -p`.
 * claudeVariant takes precedence over source defaults.
 */
export function pickEngineKey(opts: {
  source?: string;
  claudeVariant?: "headless" | "interactive";
}): "headless" | "interactive" {
  if (opts.claudeVariant === "interactive") return "interactive";
  if (opts.claudeVariant === "headless") return "headless";
  // No explicit variant → default by source. Only web can implicitly become interactive in future;
  // for now, source default is always "headless" (cron/connectors are headless; web defaults to headless
  // unless the client explicitly opts in via claudeVariant=interactive).
  return "headless";
}
