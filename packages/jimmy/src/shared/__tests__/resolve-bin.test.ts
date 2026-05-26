import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveExecutable } from "../resolve-bin.js";

describe("resolveExecutable", () => {
  let tmpDir: string;
  let origPath: string | undefined;
  let origPathExt: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-bin-"));
    origPath = process.env.PATH;
    origPathExt = process.env.PATHEXT;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.PATH = origPath;
    if (origPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = origPathExt;
  });

  it("returns absolute paths unchanged", () => {
    const abs = path.resolve(tmpDir, "anything");
    expect(resolveExecutable(abs)).toBe(abs);
  });

  it("returns the input when no match is found on PATH", () => {
    process.env.PATH = tmpDir;
    expect(resolveExecutable("definitely-not-installed-xyz")).toBe("definitely-not-installed-xyz");
  });

  it("finds an executable by bare name on PATH", () => {
    const ext = process.platform === "win32" ? ".EXE" : "";
    const binPath = path.join(tmpDir, "fakebin" + ext);
    fs.writeFileSync(binPath, "");
    if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
    process.env.PATH = tmpDir;
    if (process.platform === "win32") process.env.PATHEXT = ".EXE;.CMD";
    expect(resolveExecutable("fakebin")).toBe(binPath);
  });
});
