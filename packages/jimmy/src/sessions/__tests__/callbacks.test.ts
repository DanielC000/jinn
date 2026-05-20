import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { Session } from "../../shared/types.js";

vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: { port: 7777, host: "127.0.0.1" } })),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { notifyParentSession } from "../callbacks.js";
import { getSession } from "../registry.js";

const mockedGetSession = vi.mocked(getSession);

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "child-1",
    engine: "claude",
    engineSessionId: "eng-child-1",
    source: "web",
    sourceRef: "web:child-1",
    connector: null,
    sessionKey: "web:child-1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "Kai",
    model: null,
    title: null,
    parentSessionId: "parent-1",
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    archivedAt: null,
    archivedTo: null,
    archivedFrom: null,
    summaryPrompt: null,
    autoSplitDisabled: false,
    ...overrides,
  };
}

/**
 * Flushes microtasks so the fire-and-forget `_sendNotification().catch(...)`
 * chain has a chance to call `fetch` before assertions run.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("notifyParentSession", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    mockedGetSession.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("no-ops when child has no parent", async () => {
    const child = fakeSession({ parentSessionId: null });
    notifyParentSession(child, { result: "done" });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedGetSession).not.toHaveBeenCalled();
  });

  test("skips when parent has been deleted", async () => {
    mockedGetSession.mockReturnValue(undefined);
    const child = fakeSession();
    notifyParentSession(child, { result: "done" });
    await flush();
    expect(mockedGetSession).toHaveBeenCalledWith("parent-1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("skips when parent is in error state (avoid feedback loop)", async () => {
    mockedGetSession.mockReturnValue(fakeSession({ id: "parent-1", status: "error" }));
    const child = fakeSession();
    notifyParentSession(child, { result: "done" });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("posts a success notification with employee name + child session ID + preview", async () => {
    mockedGetSession.mockReturnValue(fakeSession({ id: "parent-1", status: "idle" }));
    const child = fakeSession({
      id: "94bb0c74",
      employee: "Kai",
      parentSessionId: "4ee1c7fb",
    });
    notifyParentSession(child, { result: "Dispatched 10 Longform pipelines. All green." });
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/4ee1c7fb/message");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.role).toBe("notification");
    expect(body.message).toContain("📩");
    expect(body.message).toContain('Employee "Kai"');
    expect(body.message).toContain("session 94bb0c74");
    expect(body.message).toContain("GET /api/sessions/94bb0c74?last=N");
    expect(body.message).toContain("Dispatched 10 Longform pipelines. All green.");
  });

  test("truncates long previews to 200 chars + ellipsis", async () => {
    mockedGetSession.mockReturnValue(fakeSession({ id: "parent-1", status: "idle" }));
    const longReply = "x".repeat(500);
    notifyParentSession(fakeSession(), { result: longReply });
    await flush();

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const preview = body.message.split("Preview: ")[1];
    expect(preview).toBe("x".repeat(200) + "...");
  });

  test("posts an error notification when the child errored out", async () => {
    mockedGetSession.mockReturnValue(fakeSession({ id: "parent-1", status: "idle" }));
    notifyParentSession(fakeSession({ employee: "Aaron" }), {
      error: "engine crashed mid-turn",
    });
    await flush();

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.role).toBe("notification");
    expect(body.message).toContain("⚠️");
    expect(body.message).toContain('Employee "Aaron"');
    expect(body.message).toContain("engine crashed mid-turn");
  });

  test("falls back to 'Unknown' when child has no employee name", async () => {
    mockedGetSession.mockReturnValue(fakeSession({ id: "parent-1", status: "idle" }));
    notifyParentSession(fakeSession({ employee: null }), { result: "done" });
    await flush();

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.message).toContain('Employee "Unknown"');
  });

  test("swallows fetch errors — never rethrows to caller", async () => {
    mockedGetSession.mockReturnValue(fakeSession({ id: "parent-1", status: "idle" }));
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    // No await, no try/catch — verify this doesn't throw or produce unhandled rejection.
    expect(() => notifyParentSession(fakeSession(), { result: "done" })).not.toThrow();
    await flush();
    // Caller should not see the rejection.
    expect(fetchSpy).toHaveBeenCalled();
  });
});
