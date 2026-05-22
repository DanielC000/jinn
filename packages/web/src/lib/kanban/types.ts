// Kanban board types

// Phase 4: status enum now mirrors the backend Task status enum (matches
// shared/types.ts TaskStatus on the gateway side). The "stalled" variant
// is set by the phase-6 reconciler and rendered with a badge on the card.
export type TicketStatus =
  | 'backlog'
  | 'todo'
  | 'in-progress'
  | 'waiting'
  | 'review'
  | 'done'
  | 'stalled'

// Phase 4: priority enum aligned with backend TaskPriority. "medium" alias
// kept for backwards compat where stored localStorage still uses it.
export type TicketPriority = 'low' | 'med' | 'medium' | 'high'

// Task kind — mirrors the backend TaskKind. "standard" tasks ship artifacts;
// "spike" tasks are time-boxed explorations that ship a decision.
export type TicketKind = 'standard' | 'spike'

export type WorkState = 'idle' | 'starting' | 'working' | 'done' | 'failed'

export interface KanbanTicket {
  id: string
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  assigneeId: string | null // employee name from /api/org (Phase 4: derived from lead employee or null)
  department: string | null // department for API persistence (Phase 4: ignored, kept for shape compat)
  workState: WorkState
  createdAt: number
  updatedAt: number
  /** The department this ticket belongs to; null for tickets not yet saved to any department */
  departmentId: string | null
  /** Phase 6: present when this task is stalled, surfaced as a banner. */
  stalled?: boolean
  /** The task this one supersedes (replaces) — set when this is a follow-up. */
  supersedesTaskId?: string | null
  /** Tasks that supersede this one (i.e. follow-ups filed after this task closed). */
  supersededByTaskIds?: string[]
  /** Retrospective summary, generated on close. Null until the summariser has run. */
  summary?: string | null
  summaryGeneratedAt?: string | null
  /** Task kind — standard (default, artifact deliverable) or spike (decision deliverable). */
  kind?: TicketKind
  /** Informational time-box in hours (no enforcement). */
  timeBoxHours?: number | null
  /** Operator's close notes — for spikes, the decision. */
  closeNotes?: string | null
}

export interface KanbanColumn {
  id: TicketStatus
  title: string
}

export const COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'todo', title: 'To Do' },
  { id: 'in-progress', title: 'In Progress' },
  { id: 'waiting', title: 'Waiting' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
]

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'var(--system-green)',
  med: 'var(--system-orange)',
  medium: 'var(--system-orange)',
  high: 'var(--system-red)',
}
