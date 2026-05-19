/**
 * Auto-split mega-chats — summarizer (Phase 1.3).
 *
 * Given a session that's about to be archived, produce a compact structured
 * summary by replaying the existing transcript through a cheap model (Sonnet
 * by default). The returned text becomes the new session's `summary_prompt`,
 * injected via --append-system-prompt on every subsequent turn so the
 * conversation continues with context but without re-paying the full
 * transcript rehydration cost.
 *
 * Why Sonnet by default: summarization is one of the easiest tasks for a
 * frontier model. Sonnet does it well at ~5× lower Max-quota cost than Opus.
 * The summarizer model is configurable per autoSplit config.
 */
import type { Engine, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export interface SummarizeOpts {
  /** The session being archived. Must have a non-null engineSessionId. */
  session: Session;
  /** Engine to use (typically the Claude one-shot engine). */
  engine: Engine;
  /** Binary path (defaults to "claude"). */
  bin?: string;
  /** CWD for the spawn — typically JINN_HOME so the engine can read project files. */
  cwd: string;
  /** Model alias or full id. Defaults to "sonnet". */
  model?: string;
}

/**
 * The structured prompt asks for five named sections so downstream summaries
 * are predictable. The model is told to be ruthless about brevity — every
 * token in this summary will be re-sent on every future turn of the
 * successor session, so size matters more than fidelity.
 */
const SUMMARIZER_PROMPT = `You are about to summarize a conversation that has grown too long for efficient continuation. Your output will be injected as a system prompt on every future turn of a fresh successor session, so be ruthless about brevity — every token costs us on every turn from here on.

Read the entire prior conversation via your --resume transcript and produce a structured summary in exactly the following markdown shape. Keep the whole thing under 1500 tokens. Omit any section that genuinely has nothing to record (don't pad).

# Prior conversation summary

## Goals
What the user is trying to accomplish in this thread. 1–3 bullets.

## Decisions made
Locked choices, with enough specificity that we can reference them later without re-deriving. Date/turn-range citations welcome.

## Open questions
Unresolved items the conversation has explicitly parked.

## Current state
What's in flight right now — work in progress, awaiting input, recently completed.

## Key references
Files, sessions, employees, external links mentioned. Wikilink-style is fine ([[Name]]).

Return ONLY the markdown summary above. No preamble, no postscript, no commentary about the summarization itself.`;

/**
 * Run the summarizer against an existing session's transcript.
 * Returns the summary text (suitable for storing in sessions.summary_prompt).
 *
 * Throws if the session has no engineSessionId (nothing to resume),
 * if the engine errors, or if the result is empty.
 */
export async function summarizeSession(opts: SummarizeOpts): Promise<string> {
  const { session, engine, bin, cwd } = opts;
  const model = opts.model ?? "sonnet";

  if (!session.engineSessionId) {
    throw new Error(
      `summarizeSession: session ${session.id} has no engineSessionId — cannot --resume to summarize`,
    );
  }

  logger.info(
    `Summarizing session ${session.id} (engine_session_id=${session.engineSessionId}, model=${model})`,
  );

  const result = await engine.run({
    prompt: SUMMARIZER_PROMPT,
    resumeSessionId: session.engineSessionId,
    cwd,
    bin,
    model,
    sessionId: session.id,
    source: session.source,
    // No systemPrompt — the resume context is already loaded, and we want
    // a focused summarization pass without Jinn's full org context cluttering it.
  });

  if (result.error) {
    throw new Error(`summarizeSession: engine error — ${result.error}`);
  }
  const summary = result.result?.trim();
  if (!summary) {
    throw new Error(`summarizeSession: engine returned empty result`);
  }

  logger.info(
    `Summarized session ${session.id}: ${summary.length} chars, cost=$${(result.cost ?? 0).toFixed(4)}`,
  );
  return summary;
}
