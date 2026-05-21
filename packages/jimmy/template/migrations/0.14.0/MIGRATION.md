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

# Top-level cruft from accidental shell redirects
$cruft = @('=4.7','=95%','Deploy','Packaging','Scryloft','Shipping','Unpacking','Verifying')
foreach ($f in $cruft) { Remove-Item -Force "$env:USERPROFILE\.jinn\$f" -ErrorAction SilentlyContinue }
Get-ChildItem "$env:USERPROFILE\.jinn" -Filter "CUsersdanie*" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
```

## Boot the new gateway

```bash
git checkout v0.14.0
pnpm install
pnpm build
pnpm start
```

The first-boot migration runs automatically (`packages/jimmy/src/sessions/migrations/001-organisations.ts`):

1. Creates one Organisation row named **"Scryloft"** with `lead_employee_id="jinn"` and `wip_cap=3`.
2. Copies `~/.jinn/org/` → `~/.jinn/organisations/<scryloft-id>/org/` (and removes the source after successful copy).
3. Indexes employees from the moved org dir into the `employees` table.
4. Indexes cron jobs from `~/.jinn/cron/jobs.json` into `cron_jobs` with `task_mode="untracked"`.

## Verification checklist (first 5 minutes)

- [ ] `GET /api/organisations` returns one Organisation named "Scryloft", `leadEmployeeId: "jinn"`, `wipCap: 3`.
- [ ] `GET /api/organisations/<id>/tasks` returns `[]` (no tasks yet).
- [ ] UI top of sidebar shows the Organisation switcher with "Scryloft" selected.
- [ ] `GET /api/skills` (no `organisation` param) returns your global skills as before.
- [ ] `GET /api/skills?organisation=<id>` returns the same set (no per-Org overlay exists yet).
- [ ] Open a chat with `jinn` from the sidebar — it spins up, says hello.
- [ ] System prompt for `jinn` includes the new task-bound delegation protocol (look for "Task-bound vs untracked" section).
- [ ] Skills are visible at `/api/skills` (10 expected).
- [ ] Cron job `usage-limit-wake` is still in `~/.jinn/cron/jobs.json` (disabled).

## Re-onboarding the team

Send Jinn a single message:

> The new workflow is live. Read `Projects/Jinn/Project-Scoped Task-Bound Workflow.md` in the vault for the full design. The short version:
>
> - Task-bound sessions: when the auto-picker dispatches you a task from the Kanban, your session is bound to that task. Iteration happens inside the open task. Closing the task archives all involved sessions together.
> - Use the `create_task` tool (`POST /api/sessions/<your-id>/tools/create-task`) to file work onto the Kanban. Default destination is Backlog; promote to To Do when ready for the auto-picker.
> - Untracked chats (sidebar-initiated, no task) still work exactly as before for quick pings.
> - WIP cap is 3 — that's how many tasks the team works on concurrently.
>
> Echo this brief to Sasha (`director-sasha`) and Leon (`lead-leon`) so they can brief their reports.

## Initial Kanban seed

File these in Backlog and promote to To Do as you're ready (these are validation tasks for the new system — run them before doing real work):

1. **Verify delegation-event rows.** `lead-aaron`. Spawn a single child via the new protocol; check the parent's messages table contains a `role='delegation'` row. To Do.
2. **Verify notification taskId.** `lead-aaron`. Reply from a task-bound child; check the parent notification contains `[Task: "<title>"]`. To Do.
3. **Test the WIP cap.** `manager-cora`. File three trivial tasks at once; first should dispatch immediately, second when the first hits Waiting/Done. To Do.
4. **Test the reconciler.** `lead-aaron`. Kill the lead session mid-task; verify the 60s reconciler marks the task `stalled` and the UI banner appears. To Do.
5. **Re-enable cron `usage-limit-wake`** if Anthropic's claude -p deadline is still in play. Backlog until decision.

## What's NOT in scope for this migration

- **Anthropic Max session state** — lives in Claude Code's own credentials; untouched.
- **Vault content** — Obsidian vault is separate; not touched.
- **Forgejo/GitHub repo state** — git-managed, untouched.
- **Whisper STT model** — already on disk (~465 MB).

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
