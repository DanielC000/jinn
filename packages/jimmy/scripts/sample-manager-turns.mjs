#!/usr/bin/env node
// Diagnostic: sample N random assistant turns from manager-rank employees so the
// operator can classify each as INTEGRATION (combines multiple reports) vs ROUTING
// (translates one input to one output). Drives the decision about whether each
// manager rank is buying cognitive depth or just decoration.
//
// Usage: node scripts/sample-manager-turns.mjs [--n=10] [--out=path.md]
// Env:   JINN_HOME (defaults to ~/.jinn)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const N = parseInt(args.n ?? 10, 10);
const JINN_HOME = process.env.JINN_HOME || path.join(os.homedir(), '.jinn');
const DB_PATH = path.join(JINN_HOME, 'sessions', 'registry.db');
const OUT_PATH = args.out || path.join(JINN_HOME, 'manager-turn-sample.md');

if (!fs.existsSync(DB_PATH)) {
  console.error(`No registry.db at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const managers = db.prepare(`
  SELECT e.name, e.display_name, e.department, e.rank, o.name AS org_name, o.id AS org_id
  FROM employees e
  JOIN organisations o ON o.id = e.organisation_id
  WHERE LOWER(e.rank) = 'manager'
  ORDER BY o.name, e.name
`).all();

console.log(`Found ${managers.length} manager-rank employee(s):`);
for (const m of managers) {
  console.log(`  - ${m.display_name || m.name} (${m.name}) @ ${m.org_name}`);
}

if (managers.length === 0) {
  console.error('No manager-rank employees. Nothing to sample.');
  process.exit(0);
}

// Find all assistant messages on sessions assigned to a manager-rank employee
const turns = db.prepare(`
  SELECT m.id, m.session_id, m.content, m.timestamp,
         s.employee AS session_employee, s.organisation_id, s.task_id,
         s.title AS session_title
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  JOIN employees e ON e.organisation_id = s.organisation_id AND e.name = s.employee
  WHERE m.role = 'assistant'
    AND LOWER(e.rank) = 'manager'
    AND LENGTH(m.content) > 50
  ORDER BY RANDOM()
  LIMIT ?
`).all(N);

console.log(`\nSampled ${turns.length} manager turn(s) (target ${N}).`);

if (turns.length === 0) {
  const totalSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  const totalMessages = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  console.error(
    `No manager assistant turns found.\n` +
    `  Total sessions: ${totalSessions}\n` +
    `  Total messages: ${totalMessages}\n` +
    `  Managers defined: ${managers.length}\n\n` +
    `Likely causes:\n` +
    `  - DB was recently wiped (e.g. v0.14.0 cutover) and managers haven't been used yet\n` +
    `  - sessions.employee field is unset on existing rows (legacy data)\n` +
    `  - Manager-rank employees haven't been delegated to in this DB\n\n` +
    `Re-run after the workforce has accumulated real turns.`
  );
  process.exit(0);
}

// Format markdown for classification
const orgNameById = Object.fromEntries(managers.map((m) => [m.org_id, m.org_name]));

const lines = [
  '---',
  'tags: [jinn, diagnostic, manager-routing-ratio]',
  `date: ${new Date().toISOString().slice(0, 10)}`,
  '---',
  '',
  '# Manager Turn Sample — Integration vs Routing Diagnostic',
  '',
  '## Instructions',
  '',
  'For each turn below, classify the manager\'s action as one of:',
  '',
  '- **[I] INTEGRATION** — combines information from multiple reports/sources, or makes a non-trivial cross-stream call. The turn would be qualitatively worse without a tier doing this work.',
  '- **[R] ROUTING** — translates one input (e.g. COO brief) into one output (e.g. brief to a single engineer). The turn could be replaced by a direct delegation with no real loss.',
  '- **[?]** — genuinely ambiguous; flag for re-read.',
  '',
  'Tick the box next to your classification on each turn.',
  '',
  'When done: count I vs R. If R ≫ I (say, >70 % routing), that manager rank is decorative — collapse it. If I ≫ R, the rank is buying real integration work — keep it.',
  '',
  `Sampled: ${turns.length} turns across ${new Set(turns.map((t) => t.session_employee)).size} manager(s).`,
  '',
  '---',
  '',
];

turns.forEach((t, idx) => {
  const org = orgNameById[t.organisation_id] || '(unknown org)';
  const ts = new Date(t.timestamp).toISOString();
  const sessionShort = t.session_id.slice(0, 8);
  const taskNote = t.task_id ? ` task=${t.task_id.slice(0, 8)}` : ' (untracked)';
  const titleNote = t.session_title ? ` — "${t.session_title}"` : '';

  // Truncate content to ~3 KB so the file is reviewable, but flag the truncation.
  const MAX_LEN = 3000;
  let content = t.content;
  let truncated = false;
  if (content.length > MAX_LEN) {
    content = content.slice(0, MAX_LEN) + '\n\n…[truncated, original ' + t.content.length + ' chars]';
    truncated = true;
  }

  lines.push(`## Turn ${idx + 1} — ${t.session_employee} @ ${org}`);
  lines.push('');
  lines.push(`- Session: \`${sessionShort}\`${titleNote}`);
  lines.push(`- When: ${ts}`);
  lines.push(`- Org: ${org}${taskNote}`);
  if (truncated) lines.push(`- ⚠ Content truncated to ${MAX_LEN} chars (original ${t.content.length})`);
  lines.push('');
  lines.push('**Classification:**');
  lines.push('- [ ] [I] Integration — combines multiple reports/sources');
  lines.push('- [ ] [R] Routing — one-input → one-output translation');
  lines.push('- [ ] [?] Ambiguous');
  lines.push('');
  lines.push('**Content:**');
  lines.push('');
  lines.push('```');
  lines.push(content);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
});

// Tally template
lines.push('## Tally');
lines.push('');
lines.push('| Manager | Integration | Routing | Ambiguous | Verdict |');
lines.push('|---|---|---|---|---|');
const byManager = {};
for (const t of turns) {
  if (!byManager[t.session_employee]) byManager[t.session_employee] = 0;
  byManager[t.session_employee]++;
}
for (const [name, count] of Object.entries(byManager)) {
  lines.push(`| ${name} (${count} turns sampled) | _fill in_ | _fill in_ | _fill in_ | _keep / collapse / unclear_ |`);
}
lines.push('');
lines.push('## Notes');
lines.push('');
lines.push('(operator commentary — what surprised you, edge cases, etc.)');
lines.push('');

fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
console.log(`\nWrote ${OUT_PATH}`);
console.log('Open it, classify each turn, and tally per-manager at the bottom.');

db.close();
