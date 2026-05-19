import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";

const db = new Database(path.join(os.homedir(), ".jinn", "sessions", "registry.db"), { readonly: true });

const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", rows.map((r) => r.name).join(", "));

const cols = db.prepare("PRAGMA table_info(sessions)").all();
console.log("\nsessions columns:", cols.map((c) => `${c.name}:${c.type}`).join(", "));

const totals = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(total_cost),0) cost_total, COALESCE(SUM(total_turns),0) turns_total FROM sessions").get();
console.log("\nTotal sessions:", totals);

const byEmp = db.prepare("SELECT employee, model, COUNT(*) n, COALESCE(SUM(total_cost),0) cost, COALESCE(SUM(total_turns),0) turns FROM sessions GROUP BY employee, model ORDER BY cost DESC").all();
console.log("\nBy employee + model:");
for (const r of byEmp) console.log(" ", r);

const byStatus = db.prepare("SELECT status, COUNT(*) n, COALESCE(SUM(total_cost),0) cost, COALESCE(SUM(total_turns),0) turns FROM sessions GROUP BY status ORDER BY cost DESC").all();
console.log("\nBy status:");
for (const r of byStatus) console.log(" ", r);

const top = db.prepare("SELECT id, employee, model, status, total_cost cost, total_turns turns, last_activity, substr(COALESCE(title,''),1,60) title FROM sessions ORDER BY total_cost DESC LIMIT 10").all();
console.log("\nTop 10 sessions by cost:");
for (const r of top) console.log(" ", r);

const recent = db.prepare("SELECT DATE(last_activity) d, COUNT(*) n, COALESCE(SUM(total_cost),0) cost, COALESCE(SUM(total_turns),0) turns FROM sessions GROUP BY DATE(last_activity) ORDER BY d DESC LIMIT 10").all();
console.log("\nPer-day activity (last 10 days):");
for (const r of recent) console.log(" ", r);
