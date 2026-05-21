import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Phase 1 first-boot migration smoke tests.
 *
 * The migration touches three concerns:
 *   1. Creates the Default Organisation when the table is empty.
 *   2. Moves a legacy ~/.jinn/org/ directory into ~/.jinn/organisations/<id>/org/.
 *   3. Populates the employees + cron_jobs synthetic indexes.
 *
 * We isolate by pointing JINN_HOME at a temp dir and re-importing the modules
 * with a fresh module cache so SESSIONS_DB / paths.ts pick up the override.
 */

interface MigrationCtx {
  tmp: string;
  registry: typeof import("../registry.js");
  migration: typeof import("../migrations/001-organisations.js");
}

async function withFreshHome(): Promise<MigrationCtx> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-migration-"));
  process.env.JINN_HOME = tmp;
  vi.resetModules();
  const registry = await import("../registry.js");
  const migration = await import("../migrations/001-organisations.js");
  registry.initDb();
  return { tmp, registry, migration };
}

function writeYaml(filePath: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = Object.entries(body).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("Phase 1 migration: 001-organisations", () => {
  const originalHome = process.env.JINN_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = originalHome;
  });

  test("creates Default Organisation when the table is empty", async () => {
    const { migration, registry } = await withFreshHome();
    const result = migration.runOrganisationsMigration();
    expect(result.ran).toBe(true);
    expect(result.organisationId).toBeTruthy();
    const orgs = registry.listOrganisations();
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe(migration.DEFAULT_ORG_NAME);
    expect(orgs[0].leadEmployeeId).toBe(migration.DEFAULT_ORG_LEAD);
    expect(orgs[0].wipCap).toBe(migration.DEFAULT_ORG_WIP_CAP);
  });

  test("is idempotent on a second run (no second Organisation)", async () => {
    const { migration, registry } = await withFreshHome();
    migration.runOrganisationsMigration();
    const second = migration.runOrganisationsMigration();
    expect(second.ran).toBe(false);
    expect(registry.listOrganisations()).toHaveLength(1);
  });

  test("moves a legacy org/ directory into organisations/<id>/org/", async () => {
    const { tmp, migration, registry } = await withFreshHome();
    const legacyOrg = path.join(tmp, "org");
    writeYaml(path.join(legacyOrg, "engineering", "lead-alpha.yaml"), {
      name: "lead-alpha",
      displayName: "Leon",
      department: "engineering",
      rank: "senior",
      persona: "Eng lead",
    });

    const result = migration.runOrganisationsMigration();
    expect(result.ran).toBe(true);
    expect(result.movedOrgDir).toBe(true);
    expect(fs.existsSync(legacyOrg)).toBe(false);

    const newOrgRoot = path.join(tmp, "organisations", result.organisationId!);
    expect(fs.existsSync(path.join(newOrgRoot, "org", "engineering", "lead-alpha.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(newOrgRoot, ".migrated-from-legacy"))).toBe(true);

    const indexed = registry.listEmployeeIndex(result.organisationId!);
    expect(indexed.map((e) => e.name)).toContain("lead-alpha");
  });

  test("indexes cron jobs from ~/.jinn/cron/jobs.json with default task_mode='untracked'", async () => {
    const { tmp, migration, registry } = await withFreshHome();
    const jobsPath = path.join(tmp, "cron", "jobs.json");
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(
      jobsPath,
      JSON.stringify([
        { id: "usage-limit-wake", name: "Usage limit wake", enabled: false, schedule: "30 6 * * *", prompt: "ping" },
      ]),
      "utf-8",
    );

    const result = migration.runOrganisationsMigration();
    expect(result.cronJobCount).toBe(1);
    const cron = registry.listCronJobIndex(result.organisationId!);
    expect(cron).toHaveLength(1);
    expect(cron[0].taskMode).toBe("untracked");
    expect(cron[0].id).toBe("usage-limit-wake");
  });

  test("handles a JINN_HOME with no legacy org/ (fresh boot)", async () => {
    const { tmp, migration } = await withFreshHome();
    const result = migration.runOrganisationsMigration();
    expect(result.ran).toBe(true);
    expect(result.movedOrgDir).toBe(false);
    // organisations/<id>/org/ should still get created (empty) so later phases can write into it.
    expect(fs.existsSync(path.join(tmp, "organisations", result.organisationId!, "org"))).toBe(true);
  });
});
