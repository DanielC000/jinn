import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { JINN_HOME, ORG_DIR, ORGANISATIONS_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { loadJobs } from "../../cron/jobs.js";
import {
  createOrganisation,
  listOrganisations,
  upsertEmployeeIndex,
  upsertCronJobIndex,
} from "../registry.js";

/**
 * Project-scoped task-bound workflow — first-boot migration.
 *
 * Idempotent: only runs when the `organisations` table is empty. Subsequent
 * boots no-op. Safe to call on every gateway start.
 *
 * Steps:
 *   1. Create one Organisation row named "Default" with no lead employee.
 *      The operator picks a lead via the UI / `PATCH /api/organisations/:id`.
 *   2. If ~/.jinn/org/ exists, copy it into ~/.jinn/organisations/<id>/org/
 *      and remove the source (copy-then-delete so an interrupted move can be
 *      detected and retried). Drop a .migrated flag inside the new dir so a
 *      re-run can short-circuit even if the org table was wiped.
 *   3. Scan the new (or pre-existing) org dir, populate the `employees`
 *      synthetic-index table for FK targets.
 *   4. Load ~/.jinn/cron/jobs.json into the `cron_jobs` index attached to the
 *      default Organisation, with task_mode="untracked" (today's behavior).
 */

export const DEFAULT_ORG_NAME = "Default";
export const DEFAULT_ORG_LEAD: string | null = null;
export const DEFAULT_ORG_WIP_CAP = 3;

export interface MigrationResult {
  ran: boolean;
  organisationId?: string;
  movedOrgDir?: boolean;
  employeeCount?: number;
  cronJobCount?: number;
}

export function runOrganisationsMigration(opts: { jinnHome?: string } = {}): MigrationResult {
  const home = opts.jinnHome ?? JINN_HOME;
  const existing = listOrganisations();
  if (existing.length > 0) {
    return { ran: false };
  }

  const org = createOrganisation({
    name: DEFAULT_ORG_NAME,
    leadEmployeeId: DEFAULT_ORG_LEAD,
    wipCap: DEFAULT_ORG_WIP_CAP,
  });
  logger.info(`[migration:001] created Organisation "${org.name}" (${org.id})`);

  const orgsDir = path.join(home, "organisations");
  const newOrgRoot = path.join(orgsDir, org.id);
  const newOrgDir = path.join(newOrgRoot, "org");

  const legacyOrgDir = path.join(home, "org");
  let movedOrgDir = false;
  if (fs.existsSync(legacyOrgDir) && !fs.existsSync(newOrgDir)) {
    fs.mkdirSync(newOrgRoot, { recursive: true });
    copyDirSync(legacyOrgDir, newOrgDir);
    // Drop a flag so accidental re-runs can be detected even if the DB was wiped.
    fs.writeFileSync(
      path.join(newOrgRoot, ".migrated-from-legacy"),
      new Date().toISOString(),
      "utf-8",
    );
    // Only delete the legacy dir after successful copy.
    fs.rmSync(legacyOrgDir, { recursive: true, force: true });
    movedOrgDir = true;
    logger.info(`[migration:001] moved ${legacyOrgDir} -> ${newOrgDir}`);
  } else if (!fs.existsSync(newOrgDir)) {
    fs.mkdirSync(newOrgDir, { recursive: true });
  }

  // Populate the synthetic employees index from whichever org dir is now authoritative.
  // We point scanOrg at the new location by setting ORG_DIR via the env, but scanOrg
  // reads ORG_DIR at module-load. To stay decoupled, copy the scan logic inline via
  // its public API on the legacy path it already knows, then write rows.
  const employees = scanOrgAt(newOrgDir);
  let employeeCount = 0;
  for (const emp of employees) {
    upsertEmployeeIndex(org.id, {
      name: emp.name,
      displayName: emp.displayName,
      department: emp.department,
      rank: emp.rank,
    });
    employeeCount += 1;
  }
  logger.info(`[migration:001] indexed ${employeeCount} employees`);

  // Load cron jobs into the synthetic index. The JSON file remains source of truth.
  let cronJobCount = 0;
  try {
    const jobs = loadJobs();
    for (const job of jobs) {
      upsertCronJobIndex(job, org.id, {
        taskMode: job.taskMode ?? "untracked",
        taskId: job.taskId ?? null,
      });
      cronJobCount += 1;
    }
    logger.info(`[migration:001] indexed ${cronJobCount} cron jobs`);
  } catch (err) {
    logger.warn(`[migration:001] failed to load cron jobs: ${err}`);
  }

  return {
    ran: true,
    organisationId: org.id,
    movedOrgDir,
    employeeCount,
    cronJobCount,
  };
}

/**
 * Copy a directory tree. Equivalent to `cp -r src dst` on POSIX. Uses
 * fs.cpSync where available, falls back to a manual recursive walk.
 */
function copyDirSync(src: string, dst: string): void {
  if (typeof (fs as unknown as { cpSync?: unknown }).cpSync === "function") {
    fs.cpSync(src, dst, { recursive: true });
    return;
  }
  // Fallback walker for older Node versions.
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(sp, dp);
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}

/**
 * Scan an arbitrary org directory and return the employee metadata we index.
 * Mirrors {@link scanOrg} but takes the root path as an argument so the
 * first-boot migration can point at the new ~/.jinn/organisations/<id>/org/
 * location without mutating the shared ORG_DIR constant.
 */
function scanOrgAt(root: string): Array<{ name: string; displayName?: string; department?: string; rank?: string }> {
  if (!fs.existsSync(root)) return [];
  const out: Array<{ name: string; displayName?: string; department?: string; rank?: string }> = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".yaml") && entry.name !== "department.yaml") {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const data = yaml.load(raw) as Record<string, unknown> | null;
          if (data && typeof data === "object" && typeof data.name === "string" && typeof data.persona === "string") {
            out.push({
              name: data.name,
              displayName: typeof data.displayName === "string" ? data.displayName : undefined,
              department: typeof data.department === "string" ? data.department : path.basename(path.dirname(fullPath)),
              rank: typeof data.rank === "string" ? data.rank : "employee",
            });
          }
        } catch {
          // Skip unreadable files — scanOrg already warns on these.
        }
      }
    }
  }

  walk(root);
  return out;
}

// Reference ORG_DIR + ORGANISATIONS_DIR + JINN_HOME so they aren't flagged unused
// by aggressive bundlers — they're load-bearing constants for the layout this
// migration enforces.
export const __migrationLayout = { JINN_HOME, ORG_DIR, ORGANISATIONS_DIR };
