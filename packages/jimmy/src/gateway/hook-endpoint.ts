import { timingSafeEqual } from "node:crypto";
import type { HookRegistry, HookPayload } from "./hook-registry.js";

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
}

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } {
  // Loopback check first — defense-in-depth alongside any upstream check.
  if (!ctx.remoteAddress || !LOOPBACK.has(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  const a = Buffer.from(providedSecret ?? "", "utf-8");
  const b = Buffer.from(ctx.secret, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.jinnSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }
  ctx.reg.deliver(body.jinnSessionId, body.hook);
  return { status: 200, body: "ok" };
}
