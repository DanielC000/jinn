
import { COLUMNS } from '@/lib/kanban/types'
import type { KanbanTicket, TicketStatus } from '@/lib/kanban/types'
import type { Employee } from '@/lib/api'
import { KanbanColumn } from './kanban-column'
import { TicketCard } from './ticket-card'

interface KanbanBoardProps {
  /** Phase 4: now a flat array of tickets (was a KanbanStore record). */
  tickets: KanbanTicket[]
  employees: Employee[]
  onTicketClick: (ticket: KanbanTicket) => void
  onMoveTicket: (ticketId: string, status: TicketStatus) => void
  onCreateTicket: () => void
  onDeleteTicket?: (ticket: KanbanTicket) => void
  filterEmployeeId?: string | null
}

export function KanbanBoard({
  tickets,
  employees,
  onTicketClick,
  onMoveTicket,
  onCreateTicket,
  onDeleteTicket,
  filterEmployeeId,
}: KanbanBoardProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        height: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: 'var(--space-2) 0',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {COLUMNS.map((column) => {
        const allColumnTickets = tickets
          .filter((t) => t.status === column.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
        const columnTickets = filterEmployeeId
          ? allColumnTickets.filter((t) => t.assigneeId === filterEmployeeId)
          : allColumnTickets

        return (
          <KanbanColumn
            key={column.id}
            column={column}
            tickets={columnTickets}
            onDrop={onMoveTicket}
            onCreateTicket={column.id === 'backlog' ? onCreateTicket : undefined}
            renderTicket={(ticket) => {
              const emp = employees.find((e) => e.name === ticket.assigneeId)
              return (
                <TicketCard
                  ticket={ticket}
                  assigneeName={emp?.displayName ?? null}
                  onClick={() => onTicketClick(ticket)}
                  onDelete={onDeleteTicket ? () => onDeleteTicket(ticket) : undefined}
                />
              )
            }}
          />
        )
      })}
    </div>
  )
}
