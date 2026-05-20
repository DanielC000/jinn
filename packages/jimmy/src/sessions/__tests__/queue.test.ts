import { test, expect } from "vitest";
import { SessionQueue } from "../queue.js";

test("SessionQueue tracks queued work behind the active task", async () => {
  const queue = new SessionQueue();
  let releaseFirst: (() => void) | undefined;

  const first = queue.enqueue("slack:C123", async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });

  while (!queue.isRunning("slack:C123")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const second = queue.enqueue("slack:C123", async () => {});

  expect(queue.getPendingCount("slack:C123")).toBe(1);
  expect(queue.getTransportState("slack:C123", "running")).toBe("running");

  releaseFirst?.();
  await first;
  await second;

  expect(queue.getPendingCount("slack:C123")).toBe(0);
  expect(queue.getTransportState("slack:C123", "idle")).toBe("idle");
});

test("SessionQueue preserves error transport state", () => {
  const queue = new SessionQueue();
  expect(queue.getTransportState("slack:C123", "error")).toBe("error");
});

test("SessionQueue onChange fires on pending->running and on completion", async () => {
  const notified: string[] = [];
  const queue = new SessionQueue((sessionKey) => notified.push(sessionKey));
  await queue.enqueue("slack:C123", async () => {});
  expect(notified).toEqual(["slack:C123", "slack:C123"]);
});

test("SessionQueue onChange still fires when the queued task throws", async () => {
  const notified: string[] = [];
  const queue = new SessionQueue((sessionKey) => notified.push(sessionKey));
  await queue.enqueue("slack:C123", async () => { throw new Error("boom"); }).catch(() => {});
  // Both the start notification and the terminal notification must fire,
  // otherwise the UI would never see the item leave the queue.
  expect(notified).toEqual(["slack:C123", "slack:C123"]);
});
