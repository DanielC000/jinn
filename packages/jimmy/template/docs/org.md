# Organization

{{portalName}} supports an organizational structure with employee personas, departments, ranks, and inter-agent communication through boards.

## Employee Personas

Employee files live at `~/.jinn/org/<department>/<name>.yaml`.

```yaml
name: alice
displayName: Alice
department: engineering
rank: senior
engine: claude
model: opus
persona: |
  You are Alice, a senior engineer focused on backend systems.
  You write clean, well-tested code and prefer simple solutions.
  You review PRs thoroughly and flag potential performance issues.
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Unique identifier (lowercase, no spaces) |
| `displayName` | string | yes | Human-readable name |
| `department` | string | yes | Department directory name |
| `rank` | string | yes | One of: executive, manager, senior, employee |
| `engine` | string | yes | Engine to use: "claude" or "codex" |
| `model` | string | no | Model override (default from config) |
| `persona` | string | yes | System prompt defining personality and behavior |

## Departments

Each department is a directory under `~/.jinn/org/` containing:

```
~/.jinn/org/engineering/
  department.yaml     # Department metadata
  board.json          # Shared task board
  alice.yaml          # Employee persona
  bob.yaml            # Employee persona
```

### department.yaml

```yaml
name: engineering
displayName: Engineering
description: Builds and maintains the product codebase.
```

### board.json

A JSON array of task objects used for inter-agent communication:

```json
[
  {
    "id": "task_001",
    "title": "Refactor auth module",
    "assignee": "alice",
    "status": "in-progress",
    "priority": "high",
    "description": "Move auth logic into a dedicated service class.",
    "createdAt": "2026-01-10T14:00:00.000Z",
    "updatedAt": "2026-01-11T09:30:00.000Z"
  }
]
```

Task fields: `id`, `title`, `assignee`, `status` (open, in-progress, done, blocked), `priority` (low, medium, high, critical), `description`, `createdAt`, `updatedAt`.

## Ranks

| Rank | Privileges |
|---|---|
| **executive** | Full access. Can message any employee, modify org structure, create departments. {{portalName}} holds this rank. |
| **manager** | Can message employees in their department. Can assign tasks on their department's board. |
| **senior** | Can message employees in their department. Can update tasks assigned to them. |
| **employee** | Can update tasks assigned to them. Can post to their department's board. |

### When to add a manager rank (N≥3 rule)

A `manager` tier earns its slot only when it's doing **integration work** — combining outputs from multiple parallel reports and translating across them. Add a manager when a department has **3+ employees doing parallel work that needs integration**. Below that, give the senior delegation rights instead.

Every additional rank costs:
- One extra notification round-trip per delegation
- One extra context rebuild on the manager's session
- One extra turn of latency between brief and execution
- A token-cost multiplier proportional to the manager's session size

For N=1 or N=2, a manager tier is decorative — the cognitive value of "manager translates COO brief into engineer brief" is stylistic, not structural. The senior can delegate directly with the same outcome at a fraction of the cost.

Diagnostic: if you can't name what your manager does that a senior-with-delegation-capability couldn't, the rank is decorative. Collapse it.

## Communication

- **Downward**: Higher-ranked agents write tasks to lower-ranked agents' department boards
- **@mentions**: Messages containing `@name` route to that specific employee
- **Board-based**: Agents check their department's `board.json` for assigned tasks
- **Cross-department**: Executives and managers can write to any department's board

## Default Organization

{{portalName}} ships with a single executive employee:

```yaml
name: {{portalSlug}}
displayName: {{portalName}}
department: executive
rank: executive
engine: claude
model: opus
persona: |
  You are {{portalName}}, the executive AI assistant and gateway administrator.
  You manage the organization, delegate tasks, and handle direct requests.
```
