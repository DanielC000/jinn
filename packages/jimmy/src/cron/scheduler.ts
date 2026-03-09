import cron from "node-cron";
import type {
  CronJob,
  Engine,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";

let tasks: cron.ScheduledTask[] = [];
let currentEngines: Map<string, Engine>;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;

export function startScheduler(
  jobs: CronJob[],
  engines: Map<string, Engine>,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): void {
  currentEngines = engines;
  currentConfig = config;
  currentConnectors = connectors;
  scheduleJobs(jobs);
}

export function reloadScheduler(jobs: CronJob[]): void {
  stopScheduler();
  scheduleJobs(jobs);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}

function scheduleJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      logger.warn(
        `Invalid cron schedule for job "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        runCronJob(job, currentEngines, currentConfig, currentConnectors);
      },
      { timezone: job.timezone },
    );
    tasks.push(task);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  }
}
