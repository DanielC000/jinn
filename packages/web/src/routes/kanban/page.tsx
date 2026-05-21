
import { useEffect, useMemo, useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import type { Employee, Task, TaskStatus } from '@/lib/api'
import type { KanbanTicket, TicketPriority, TicketStatus } from '@/lib/kanban/types'
import { PageLayout, ToolbarActions } from '@/components/page-layout'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { KanbanBoard } from '@/components/kanban/kanban-board'
import { CreateTicketModal } from '@/components/kanban/create-ticket-modal'
import { TicketDetailPanel } from '@/components/kanban/ticket-detail-panel'
import { useOrg } from '@/hooks/use-employees'
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask, useRedispatchTask } from '@/hooks/use-tasks'
import { useCurrentOrganisation } from '@/context/current-organisation'
import { api } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

/** Delete confirmation dialog */
function DeleteConfirmDialog({
  ticket,
  onConfirm,
  onCancel,
}: {
  ticket: KanbanTicket
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent
        showCloseButton={false}
        className="bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-lg)] shadow-[var(--shadow-card)] max-w-[400px]"
      >
        <DialogHeader>
          <DialogTitle
            className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)]"
          >
            Delete Task
          </DialogTitle>
          <DialogDescription
            className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[1.5]"
          >
            Are you sure you want to delete &ldquo;{ticket.title}&rdquo;? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            onClick={onCancel}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-transparent text-[var(--text-secondary)] text-[length:var(--text-footnote)] font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] border-none bg-[var(--system-red)] text-white text-[length:var(--text-footnote)] font-semibold cursor-pointer"
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Phase 4 Kanban — task-bound, API-backed (was localStorage-backed in v0.13.x).
 *
 * - All state lives in the gateway; React Query reflects it.
 * - Drag-drop between columns triggers PATCH /api/tasks/:id { status }.
 * - Six columns: Backlog → To Do → In Progress → Waiting → Review → Done.
 * - Create-task form lands tickets in Backlog (auto-picker only watches To Do).
 * - The legacy localStorage Kanban store is wiped on first mount with a toast.
 */

const STORAGE_KEY_LEGACY = 'jinn-kanban'
const STORAGE_KEY_TOAST_SEEN = 'jinn:kanban-prototype-cleared-toast-v1'

function taskToTicket(task: Task, lead: Employee | null): KanbanTicket {
  const priority: TicketPriority = task.priority === 'med' ? 'medium' : (task.priority as TicketPriority)
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    status: task.status as TicketStatus,
    priority,
    // Phase 4: assignee shown is the lead employee for the active Organisation,
    // since the auto-picker (phase 6) always dispatches to that one. The
    // KanbanTicket shape carries it for the existing card UI.
    assigneeId: lead?.name ?? null,
    department: lead?.department ?? null,
    workState: task.status === 'stalled' ? 'failed' : 'idle',
    createdAt: new Date(task.createdAt).getTime(),
    updatedAt: new Date(task.updatedAt).getTime(),
    departmentId: lead?.department ?? null,
    stalled: task.status === 'stalled',
  }
}

export default function KanbanPage() {
  const { current: currentOrg } = useCurrentOrganisation()
  const { data: org, isLoading: orgLoading } = useOrg()
  const tasksQuery = useTasks()
  const createTaskMutation = useCreateTask()
  const updateTaskMutation = useUpdateTask()
  const deleteTaskMutation = useDeleteTask()
  const redispatchTaskMutation = useRedispatchTask()
  const qc = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<KanbanTicket | null>(null)
  const [filterEmployeeId, setFilterEmployeeId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<KanbanTicket | null>(null)
  const [clearedToast, setClearedToast] = useState(false)

  const employees: Employee[] = org?.employees ?? []
  const leadEmployee = useMemo(() => {
    if (!currentOrg?.leadEmployeeId) return null
    return employees.find((e) => e.name === currentOrg.leadEmployeeId) ?? null
  }, [currentOrg, employees])

  // One-time discard of the legacy localStorage data, per Phase 4 spec.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const seen = window.localStorage.getItem(STORAGE_KEY_TOAST_SEEN)
    const legacy = window.localStorage.getItem(STORAGE_KEY_LEGACY)
    if (legacy && !seen) {
      window.localStorage.removeItem(STORAGE_KEY_LEGACY)
      window.localStorage.setItem(STORAGE_KEY_TOAST_SEEN, '1')
      setClearedToast(true)
    }
  }, [])

  const tickets: KanbanTicket[] = useMemo(() => {
    const tasks = tasksQuery.data ?? []
    return tasks.map((t) => taskToTicket(t, leadEmployee))
  }, [tasksQuery.data, leadEmployee])

  const handleCreateTicket = useCallback(
    (data: { title: string; description: string; priority: TicketPriority; assigneeId: string | null }) => {
      const priority = data.priority === 'medium' ? 'med' : data.priority
      createTaskMutation.mutate({
        title: data.title,
        description: data.description,
        priority: priority as 'low' | 'med' | 'high',
        status: 'backlog',
      })
    },
    [createTaskMutation],
  )

  const handleMoveTicket = useCallback(
    (ticketId: string, status: TicketStatus) => {
      // Drag-drop into "done" closes the task to fire the close lifecycle (Phase 7).
      updateTaskMutation.mutate({ id: ticketId, data: { status: status as TaskStatus } })
    },
    [updateTaskMutation],
  )

  const handleDeleteTicket = useCallback(
    (ticketId: string) => {
      deleteTaskMutation.mutate(ticketId)
      setSelectedTicket(null)
      setDeleteConfirm(null)
    },
    [deleteTaskMutation],
  )

  const handleTicketClick = useCallback((ticket: KanbanTicket) => {
    setSelectedTicket(ticket)
  }, [])

  // Keep selectedTicket in sync as the underlying ticket updates.
  useEffect(() => {
    if (!selectedTicket) return
    const next = tickets.find((t) => t.id === selectedTicket.id)
    if (next && next.updatedAt !== selectedTicket.updatedAt) setSelectedTicket(next)
  }, [tickets, selectedTicket])

  if (tasksQuery.error) {
    return (
      <PageLayout>
        <div
          className="flex flex-col items-center justify-center h-full gap-[var(--space-4)] text-[var(--text-tertiary)]"
        >
          <div
            className="rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_10%,transparent)] border border-[color-mix(in_srgb,var(--system-red)_30%,transparent)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body)] text-[var(--system-red)]"
          >
            Failed to load tasks: {(tasksQuery.error as Error).message}
          </div>
          <button
            onClick={() => tasksQuery.refetch()}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-semibold)]"
          >
            Retry
          </button>
        </div>
      </PageLayout>
    )
  }

  const loading = tasksQuery.isLoading || orgLoading
  const ticketCount = tickets.length

  // Phase 6: WIP cap counts only In Progress + Review.
  const runningCount = tickets.filter((t) => t.status === 'in-progress' || t.status === 'review').length
  const stalledCount = tickets.filter((t) => t.status === 'stalled').length
  const wipCap = currentOrg?.wipCap ?? 3

  const adjustWipCap = useCallback(
    async (delta: number) => {
      if (!currentOrg) return
      const next = Math.max(1, wipCap + delta)
      if (next === wipCap) return
      try {
        await api.updateOrganisation(currentOrg.id, { wipCap: next })
        qc.invalidateQueries({ queryKey: queryKeys.organisations.all })
      } catch (err) {
        window.alert(`Failed to update WIP cap: ${(err as Error).message}`)
      }
    },
    [currentOrg, wipCap, qc],
  )

  const handleRedispatch = useCallback(
    (ticketId: string) => {
      redispatchTaskMutation.mutate(ticketId)
    },
    [redispatchTaskMutation],
  )

  // Show the lead employee as a filter chip when set.
  const assignedEmployeeNames = new Set(tickets.map((t) => t.assigneeId).filter(Boolean))
  const assignedEmployees = employees.filter((e) => assignedEmployeeNames.has(e.name))

  return (
    <PageLayout>
      <div className="flex h-full relative bg-[var(--bg)]">
        {/* Board area */}
        <div className="flex-1 h-full flex flex-col min-w-0">
          {/* Header */}
          <div
            className="px-[var(--space-5)] py-[var(--space-4)] flex items-center justify-between shrink-0 border-b border-[var(--separator)]"
          >
            <div>
              <h1
                className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] m-0 tracking-[-0.3px]"
              >
                Kanban Board
              </h1>
              <p
                className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[2px] mb-0"
              >
                {ticketCount} task{ticketCount !== 1 ? 's' : ''}
                {currentOrg ? ` · ${currentOrg.name}` : ''}
              </p>
            </div>

            <ToolbarActions>
              {/* Phase 6: WIP cap widget. Counting only in-progress + review (waiting is parked, doesn't consume a slot). */}
              <div className="flex items-center gap-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                <span className="px-2 py-1 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)]">
                  Tasks: {runningCount}/{wipCap}
                </span>
                <button
                  type="button"
                  onClick={() => adjustWipCap(-1)}
                  disabled={wipCap <= 1}
                  className="rounded px-1.5 py-0.5 text-xs disabled:opacity-40 hover:bg-[var(--fill-tertiary)]"
                  aria-label="Decrease WIP cap"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => adjustWipCap(+1)}
                  className="rounded px-1.5 py-0.5 text-xs hover:bg-[var(--fill-tertiary)]"
                  aria-label="Increase WIP cap"
                >
                  +
                </button>
                {stalledCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      // Re-dispatch every stalled task back to To Do; the picker
                      // grabs them on the next tick. Soft semantics on cap means
                      // it's safe to redispatch all at once even past the cap.
                      const stalled = tickets.filter((t) => t.status === 'stalled')
                      stalled.forEach((t) => handleRedispatch(t.id))
                    }}
                    className="px-2 py-1 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_20%,transparent)] text-[var(--system-red)] hover:bg-[color-mix(in_srgb,var(--system-red)_30%,transparent)]"
                    title="Re-dispatch every stalled task"
                  >
                    {stalledCount} stalled · re-dispatch
                  </button>
                )}
              </div>
              <button
                onClick={() => setCreateOpen(true)}
                className="rounded-[var(--radius-md)] px-4 py-2 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] border-none flex items-center gap-[var(--space-2)] bg-[var(--accent)] text-white cursor-pointer"
              >
                <Plus size={16} />
                New Task
              </button>
            </ToolbarActions>
          </div>

          {/* One-time toast for legacy data wipe */}
          {clearedToast && (
            <div className="px-[var(--space-5)] py-[var(--space-2)] shrink-0">
              <div className="rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] flex items-center justify-between gap-[var(--space-3)]">
                <span>The localStorage Kanban prototype data has been cleared. Tasks are now stored in the gateway.</span>
                <button
                  onClick={() => setClearedToast(false)}
                  className="rounded px-2 py-0.5 text-xs hover:bg-[var(--bg-tertiary)]"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Employee filter bar — visible when a lead has any tasks */}
          {assignedEmployees.length > 0 && (
            <div
              className="flex items-center gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-2)] overflow-x-auto shrink-0"
            >
              <button
                onClick={() => setFilterEmployeeId(null)}
                className={`flex items-center gap-[var(--space-1)] px-3 py-1 rounded-full border-none text-[length:var(--text-caption1)] font-semibold cursor-pointer shrink-0 ${
                  filterEmployeeId === null
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--fill-tertiary)] text-[var(--text-secondary)]'
                }`}
              >
                All
              </button>
              {assignedEmployees.map((emp) => (
                <button
                  key={emp.name}
                  onClick={() =>
                    setFilterEmployeeId(filterEmployeeId === emp.name ? null : emp.name)
                  }
                  className={`flex items-center gap-[var(--space-1)] px-3 py-1 rounded-full border-none text-[length:var(--text-caption1)] font-semibold cursor-pointer shrink-0 ${
                    filterEmployeeId === emp.name
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--fill-tertiary)] text-[var(--text-secondary)]'
                  }`}
                >
                  {emp.displayName}
                </button>
              ))}
            </div>
          )}

          {/* Board */}
          <div className="flex-1 px-[var(--space-3)] min-h-0">
            {loading ? (
              <div
                className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]"
              >
                Loading...
              </div>
            ) : ticketCount === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-[var(--space-3)] text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
                <span>No tasks yet.</span>
                <button
                  onClick={() => setCreateOpen(true)}
                  className="rounded-[var(--radius-md)] px-4 py-2 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] border-none flex items-center gap-[var(--space-2)] bg-[var(--accent)] text-white cursor-pointer"
                >
                  <Plus size={16} />
                  Create the first task
                </button>
              </div>
            ) : (
              <KanbanBoard
                tickets={tickets}
                employees={employees}
                onTicketClick={handleTicketClick}
                onMoveTicket={handleMoveTicket}
                onCreateTicket={() => setCreateOpen(true)}
                onDeleteTicket={(ticket) => setDeleteConfirm(ticket)}
                filterEmployeeId={filterEmployeeId}
              />
            )}
          </div>
        </div>

        {/* Mobile backdrop */}
        {selectedTicket && (
          <div
            className="fixed inset-0 z-30 lg:hidden bg-black/50"
            onClick={() => setSelectedTicket(null)}
          />
        )}

        {/* Detail panel */}
        {selectedTicket && (
          <TicketDetailPanel
            ticket={selectedTicket}
            employees={employees}
            onClose={() => setSelectedTicket(null)}
            onStatusChange={(status) => handleMoveTicket(selectedTicket.id, status)}
            onAssigneeChange={() => {
              // Phase 4: assignee is fixed to the lead. Phase 8 may expose
              // per-task assignee overrides via the new tools API.
            }}
            onDelete={() => setDeleteConfirm(selectedTicket)}
          />
        )}

        {/* Delete confirmation dialog */}
        {deleteConfirm && (
          <DeleteConfirmDialog
            ticket={deleteConfirm}
            onConfirm={() => handleDeleteTicket(deleteConfirm.id)}
            onCancel={() => setDeleteConfirm(null)}
          />
        )}

        {/* Create task modal */}
        <CreateTicketModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          employees={employees}
          onSubmit={handleCreateTicket}
        />
      </div>
    </PageLayout>
  )
}
