import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeGatewayInfo, readGatewayInfo } from "../gateway-info.js";

describe("gateway-info", () => {
  it("writeGatewayInfo round-trips and generates a secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
    const file = path.join(dir, "gateway.json");
    const info = writeGatewayInfo(file, { port: 7777, pid: 1234 });
    expect(info.port).toBe(7777);
    expect(info.pid).toBe(1234);
    expect(typeof info.secret).toBe("string");
    expect(info.secret.length).toBeGreaterThanOrEqual(32);
    expect(readGatewayInfo(file)).toEqual(info);
  });

  it("readGatewayInfo returns null when the file is missing", () => {
    expect(readGatewayInfo("/nonexistent/gateway.json")).toBe(null);
  });
});
