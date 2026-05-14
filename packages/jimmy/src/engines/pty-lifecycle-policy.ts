export interface LifecycleInputs {
  turnRunning: boolean;
  keepAlive: boolean;
  cronOrigin: boolean;
  lastViewedAt: number; // epoch ms, 0 = never
  now: number;
  graceWindowMs: number;
}

export function shouldStayAlive(i: LifecycleInputs): boolean {
  if (i.turnRunning) return true;
  if (i.keepAlive && !i.cronOrigin) return true;
  if (i.lastViewedAt > 0 && i.now - i.lastViewedAt <= i.graceWindowMs) return true;
  return false;
}
