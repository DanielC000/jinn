import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";

const db = new Database(path.join(os.homedir(), ".jinn", "sessions", "registry.db"), { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log("=== Tables ===");
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  console.log(`  ${t}: ${n} rows`);
}

console.log("\n=== messages table schema ===");
console.log(db.prepare("PRAGMA table_info(messages)").all().map((c) => `${c.name}:${c.type}`).join(", "));

console.log("\n=== queue_items schema ===");
console.log(db.prepare("PRAGMA table_info(queue_items)").all().map((c) => `${c.name}:${c.type}`).join(", "));

console.log("\n=== budget_events schema ===");
console.log(db.prepare("PRAGMA table_info(budget_events)").all().map((c) => `${c.name}:${c.type}`).join(", "));

console.log("\n=== goals schema ===");
console.log(db.prepare("PRAGMA table_info(goals)").all().map((c) => `${c.name}:${c.type}`).join(", "));

console.log("\n=== Messages by session — top 15 by message count ===");
const msgPerSession = db.prepare(`
  SELECT s.id, s.employee, s.model, s.status, substr(s.title,1,50) title,
         COUNT(m.id) msg_count,
         MIN(m.timestamp) first_msg,
         MAX(m.timestamp) last_msg
  FROM sessions s
  LEFT JOIN messages m ON m.session_id = s.id
  GROUP BY s.id
  HAVING msg_count > 0
  ORDER BY msg_count DESC LIMIT 15
`).all();
for (const r of msgPerSession) console.log(" ", r);

console.log("\n=== Activity in last 24h (since 2026-05-18T16:00) ===");
const recent24 = db.prepare(`
  SELECT s.employee, s.model, COUNT(DISTINCT s.id) sessions, COUNT(m.id) messages,
         MIN(m.timestamp) first_msg, MAX(m.timestamp) last_msg
  FROM sessions s
  JOIN messages m ON m.session_id = s.id
  WHERE m.timestamp > strftime('%s', '2026-05-18T16:00:00Z') * 1000
  GROUP BY s.employee, s.model
  ORDER BY messages DESC
`).all();
for (const r of recent24) console.log(" ", r);

console.log("\n=== Queue items by status ===");
const qByStatus = db.prepare("SELECT status, COUNT(*) n FROM queue_items GROUP BY status").all();
for (const r of qByStatus) console.log(" ", r);

console.log("\n=== Budget events — last 20 ===");
const recentBudget = db.prepare("SELECT * FROM budget_events ORDER BY created_at DESC LIMIT 20").all();
for (const r of recentBudget) console.log(" ", r);

console.log("\n=== Sessions by status (live) ===");
const byStatus = db.prepare("SELECT status, COUNT(*) n FROM sessions GROUP BY status").all();
for (const r of byStatus) console.log(" ", r);

console.log("\n=== Parent/child session topology ===");
const topo = db.prepare(`
  SELECT
    CASE WHEN parent_session_id IS NULL THEN 'root' ELSE 'child' END kind,
    COUNT(*) n
  FROM sessions GROUP BY kind
`).all();
for (const r of topo) console.log(" ", r);

console.log("\n=== Errored sessions — recent ===");
const errs = db.prepare(`
  SELECT id, employee, model, status, substr(last_error,1,120) err, last_activity
  FROM sessions WHERE last_error IS NOT NULL AND last_error <> ''
  ORDER BY last_activity DESC LIMIT 10
`).all();
for (const r of errs) console.log(" ", r);
