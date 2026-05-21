# Migration: 0.14.0 — Project-scoped task-bound workflow

## Summary

The biggest reshape of Jinn's data model since v0.9.0. Sessions are no longer free-floating per-employee chats — they're either **task-bound** (attached to a Kanban card) or **untracked** (today's behavior). Multiple **Organisations** can coexist; each owns its own Kanban, employees, cron jobs, and skills.

This is a **clean-slate cutover**: existing sessions + messages + queue items are wiped. Org YAMLs, skills, knowledge, docs, config, and cron jobs are preserved verbatim.

## Pre-cutover checklist

Before stopping the gateway:

```powershell
# Snapshot ~/.jinn (preserves org/, skills, knowledge, docs, config, cron, memory, CLAUDE.md, AGENTS.md, and the DB for forensics).
$ts = Get-Date -Format "yyyy-MM-dd-HHmm"
$backup = "$env:USERPROFILE\jinn-cutover-backup-$ts"
New-Item -ItemType Directory -Path $backup -Force | Out-Null

Copy-Item -Recurse "$env:USERPROFILE\.jinn\org"       "$backup\org"
Copy-Item -Recurse "$env:USERPROFILE\.jinn\cron"      "$backup\cron"
Copy-Item -Recurse "$env:USERPROFILE\.jinn\skills"    "$backup\skills"
Copy-Item -Recurse "$env:USERPROFILE\.jinn\knowledge" "$backup\knowledge"
Copy-Item -Recurse "$env:USERPROFILE\.jinn\docs"      "$backup\docs"
Copy-Item -Recurse "$env:USERPROFILE\.jinn\memory"    "$backup\memory"
Copy-Item "$env:USERPROFILE\.jinn\config.yaml"        "$backup\config.yaml"
Copy-Item "$env:USERPROFILE\.jinn\skills.json"        "$backup\skills.json"
Copy-Item "$env:USERPROFILE\.jinn\instances.json"     "$backup\instances.json"
Copy-Item "$env:USERPROFILE\.jinn\CLAUDE.md"          "$backup\CLAUDE.md"
Copy-Item "$env:USERPROFILE\.jinn\AGENTS.md"          "$backup\AGENTS.md"
Copy-Item "$env:USERPROFILE\.jinn\sessions\registry.db" "$backup\registry.db"

Write-Host "Backup at: $backup"
```

Copy `$backup` to a second drive before continuing.

## Wipe procedure

```powershell
# DB (recreated on next boot)
Remove-Item -Force "$env:USERPROFILE\.jinn\sessions\registry.db*"

# Caches + logs + tmp
Remove-Item -Recurse -Force "$env:USERPROFILE\.jinn\tmp\*"
Remove-Item -Recurse -Force "$env:USERPROFILE\.jinn\.claude" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.jinn\.agents" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.jinn\logs\*.log"

# Top-level cruft from accidental shell redirects (extend with the
# zero-byte / mojibake filenames you find in your own JINN_HOME).
Get-ChildItem "$env:USERPROFILE\.jinn" -File | Where-Object { $_.Length -eq 0 } | Remove-Item -Force -ErrorAction SilentlyContinue
```

## Boot the new gateway

```bash
git checkout v0.14.0
pnpm install
pnpm build
pnpm start
```

The first-boot migration runs automatically (`packages/jimmy/src/sessions/migrations/001-organisations.ts`):

1. Creates one Organisation row named **"Default"** with `lead_employee_id=null` and `wip_cap=3`. Rename and set a lead via the settings panel in the sidebar's Organisation switcher.
2. Copies `~/.jinn/org/` → `~/.jinn/organisations/<id>/org/` (and removes the source after successful copy).
3. Indexes employees from the moved org dir into the `employees` table.
4. Indexes cron jobs from `~/.jinn/cron/jobs.json` into `cron_jobs` with `task_mode="untracked"`.

## Verification checklist (first 5 minutes)

- [ ] `GET /api/organisations` returns one Organisation named "Default", `leadEmployeeId: null`, `wipCap: 3`.
- [ ] `GET /api/organisations/<id>/tasks` returns `[]` (no tasks yet).
- [ ] UI top of sidebar shows the Organisation switcher with "Default" selected.
- [ ] Rename "Default" to your project name via the settings panel; assign a lead employee.
- [ ] `GET /api/skills` (no `organisation` param) returns your global skills as before.
- [ ] `GET /api/skills?organisation=<id>` returns the same set (no per-Org overlay exists yet).
- [ ] Open a chat with one of your employees from the sidebar — it spins up.
- [ ] System prompt for the employee includes the new task-bound delegation protocol (look for "Task-bound vs untracked" section).

## Re-onboarding the team

Send a single message to your lead / COO-equivalent:

> The new workflow is live. The short version:
>
> - Task-bound sessions: when the auto-picker dispatches you a task from the Kanban, your session is bound to that task. Iteration happens inside the open task. Closing the task archives all involved sessions together.
> - Use the `create_task` tool (`POST /api/sessions/<your-id>/tools/create-task`) to file work onto the Kanban. Default destination is Backlog; promote to To Do when ready for the auto-picker.
> - Untracked chats (sidebar-initiated, no task) still work exactly as before for quick pings.
> - WIP cap is configurable per Organisation — that's how many tasks the team works on concurrently.
>
> Brief your direct reports on the same.

## Initial Kanban seed

File these in Backlog and promote to To Do as you're ready (these are validation tasks for the new system — run them before doing real work):

1. **Verify delegation-event rows.** Spawn a single child via the new protocol; check the parent's messages table contains a `role='delegation'` row. To Do.
2. **Verify notification taskId.** Reply from a task-bound child; check the parent notification contains `[Task: "<title>"]`. To Do.
3. **Test the WIP cap.** File three trivial tasks at once; first should dispatch immediately, second when the first hits Waiting/Done. To Do.
4. **Test the reconciler.** Kill the lead session mid-task; verify the 60s reconciler marks the task `stalled` and the UI banner appears. To Do.

## What's NOT in scope for this migration

- **Anthropic Max session state** — lives in Claude Code's own credentials; untouched.
- **Vault content** — Obsidian vault is separate; not touched.
- **Forgejo/GitHub repo state** — git-managed, untouched.
- **Whisper STT model** — already on disk (~465 MB).

## Restoring from a multi-tenant `.jinn_backup`

If your pre-cutover `.jinn` already held employees for **two or more logical organisations side-by-side under a single `org/` dir** (the legacy single-tenant model didn't separate them), the first-boot migration above lumps them all into a single "Default" Organisation. To split them into proper per-Org dirs:

### 1. First boot creates one Org

Boot the new gateway. First-boot migration creates one Organisation row and moves the entire backup `org/` under it. Rename that Org to your first logical org (e.g. via the sidebar settings panel).

### 2. Create the second Organisation via the UI

Use the `+ New Organisation…` footer in the sidebar Org switcher, or:

```bash
curl -X POST http://localhost:7777/api/organisations \
  -H "Content-Type: application/json" \
  -d '{"name":"Second Org","wipCap":3}'
```

This mkdirs `~/.jinn/organisations/<new-id>/org/` so YAMLs can drop in.

### 3. Move the second org's dept dirs

Stop the gateway. Copy the dept dirs that belong to the second Organisation out of the first Org's `org/` and into the second Org's `org/`:

```powershell
$first  = "$env:USERPROFILE\.jinn\organisations\<first-org-id>\org"
$second = "$env:USERPROFILE\.jinn\organisations\<second-org-id>\org"

# Adjust the dept list to your layout
foreach ($dept in @('dept-one', 'dept-two', 'dept-three')) {
  Move-Item "$first\$dept" "$second\$dept"
}
```

### 4. Re-home cross-Org `reportsTo` references

If any employee in the moved dept used `reportsTo: <name-in-the-other-org>` (commonly `reportsTo: jinn` pointing at a COO who lives in the original Org), that reference now dangles — `resolveOrgHierarchy` logs a `broken_ref` warning. Two options:

**Recommended — give each Org its own COO YAML.** Add an `executive/` department to the new Org with a local COO employee whose `name:` matches the dangling `reportsTo:` (commonly the operator's COO persona). The cross-Org reference then resolves locally because `scanOrgFromDir` is per-Org. This keeps personas that reference "(COO)" working in every Org without code changes.

```yaml
# ~/.jinn/organisations/<new-org-id>/org/executive/<coo-name>.yaml
name: <coo-name>
displayName: COO
department: executive
rank: executive
engine: claude
model: opus
persona: |
  You are the COO. You orchestrate departments, delegate to managers,
  review their work, and report results to the operator.
```

Plus an `executive/department.yaml`:

```yaml
name: executive
displayName: Executive
description: Oversees all departments.
```

**Alternative — strip the field.** The employee becomes the Org's new root. Use this when the persona doesn't actually depend on a COO parent. There's no cross-Org delegation in v0.14.0, so a cross-Org `reportsTo:` will never resolve.

### 5. (Optional) Clean up legacy `board.json` clutter

The legacy per-department `board.json` files come along for the ride but are ignored by the task-bound model. Safe to delete.

### 6. Restart and verify

Boot the gateway. Both Organisations should appear in the switcher; switching between them shows only that Org's employees on `/org` and only that Org's tasks on `/kanban`.

> **Note:** if you need to bootstrap the second Organisation **before** the Org CRUD UI shipped (older v0.14.0 builds), insert directly into the `organisations` table via `better-sqlite3` while the gateway is offline. The new endpoint at step 2 is the supported path going forward.

## Rollback plan

If the new gateway doesn't boot or the migration fails:

1. Stop the new gateway.
2. `git checkout b5e8ca3` (last commit on the prior `feat/queue-ux-and-auto-archive` HEAD).
3. Restore the DB:
   ```powershell
   Copy-Item "$backup\registry.db" "$env:USERPROFILE\.jinn\sessions\registry.db"
   ```
4. Restart. Filed-but-failed cutover task gets a new vault doc — fix on a fresh branch.

Don't delete `$backup` until at least a week of stable use on the new system.

## Schema reference

New tables:

| Table | Purpose |
|---|---|
| `organisations` | Top-level container. `id`, `name`, `lead_employee_id`, `wip_cap`, `created_at`. |
| `tasks` | Kanban rows. `id`, `organisation_id`, `title`, `description`, `priority`, `status`, `lead_session_id`, `supersedes_task_id`, `created_at`, `updated_at`, `closed_at`. |
| `employees` | Synthetic index of YAML employees, keyed `(organisation_id, name)`. |
| `cron_jobs` | Synthetic index of `~/.jinn/cron/jobs.json` rows with attached `organisation_id`, `task_mode`, `task_id`. |

New nullable FKs on `sessions`:

| Column | When | Notes |
|---|---|---|
| `organisation_id` | New sessions get the first Organisation by default. | Becomes NOT NULL in a later cleanup pass. |
| `task_id` | NULL = untracked; non-NULL = task-bound. | Inherited from parent on child spawn. |
| `employee_id` | Resolved from the synthetic employees index. | Parallel to legacy `employee` TEXT column; the latter is kept during transition. |

## API endpoints added in this release

- `GET /api/organisations` — list (Phase 1)
- `GET /api/organisations/:id` — detail (Phase 1)
- `PATCH /api/organisations/:id` — update name/lead/wip cap (Phase 6)
- `GET /api/organisations/:orgId/tasks` — list tasks (Phase 3)
- `POST /api/organisations/:orgId/tasks` — create a task (Phase 3)
- `GET /api/tasks/:id` — task detail (Phase 3)
- `PATCH /api/tasks/:id` — update task fields + transition status (Phase 3)
- `POST /api/tasks/:id/close` — terminal close + archive bound sessions (Phase 7)
- `POST /api/tasks/:id/redispatch` — clear lead, status → todo (Phase 6)
- `DELETE /api/tasks/:id` — hard delete (Phase 3)
- `POST /api/sessions/:sessionId/tools/create-task` — agent tool, rate-limited 20/hour (Phase 8a)

Existing endpoints gained `?organisation=<id>` query-param filtering: `/api/sessions`, `/api/cron`, `/api/org`, `/api/skills` (Phase 2/8c).
