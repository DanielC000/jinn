
import { useEffect, useState, useCallback } from 'react'
import { X, Pause, Play, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { api, type QueueItem } from '@/lib/api'

interface QueuePanelProps {
  sessionId: string | null
  events: Array<{ event: string; payload: unknown }>
  paused?: boolean
}

const COLLAPSE_AUTO_THRESHOLD = 10
const STORAGE_PREFIX = 'queue-panel-collapsed:'

function readCollapsedPref(sessionId: string | null): boolean | null {
  if (!sessionId || typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + sessionId)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

function writeCollapsedPref(sessionId: string | null, collapsed: boolean): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_PREFIX + sessionId, collapsed ? '1' : '0')
  } catch { /* storage may be unavailable — non-fatal */ }
}

export function QueuePanel({ sessionId, events, paused: initialPaused = false }: QueuePanelProps) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [paused, setPaused] = useState(initialPaused)
  // null = no user preference yet; the auto-threshold rule applies until the
  // user explicitly toggles, at which point we remember their choice per session.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readCollapsedPref(sessionId))

  useEffect(() => {
    setUserCollapsed(readCollapsedPref(sessionId))
  }, [sessionId])

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      const data = await api.getSessionQueue(sessionId)
      setItems(data)
    } catch {
      // non-fatal
    }
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])

  // Refresh on queue:updated WS event
  useEffect(() => {
    if (!events.length) return
    const latest = events[events.length - 1]
    if (latest.event === 'queue:updated') {
      refresh()
      const payload = latest.payload as Record<string, unknown>
      if (typeof payload?.paused === 'boolean') {
        setPaused(payload.paused as boolean)
      }
    }
  }, [events, refresh])

  const pendingItems = items.filter(i => i.status === 'pending')

  if (!sessionId || pendingItems.length === 0) return null

  // Auto-collapse when there are too many items to keep the chat history
  // visible. Once the user toggles explicitly, their choice sticks.
  const collapsed = userCollapsed ?? pendingItems.length > COLLAPSE_AUTO_THRESHOLD

  function handleToggleCollapsed() {
    const next = !collapsed
    setUserCollapsed(next)
    writeCollapsedPref(sessionId, next)
  }

  async function handleCancel(itemId: string) {
    if (!sessionId) return
    try {
      await api.cancelQueueItem(sessionId, itemId)
      await refresh()
    } catch { /* non-fatal */ }
  }

  async function handleClear() {
    if (!sessionId) return
    try {
      await api.clearSessionQueue(sessionId)
      setItems([])
    } catch { /* non-fatal */ }
  }

  async function handlePauseResume() {
    if (!sessionId) return
    try {
      if (paused) {
        await api.resumeSessionQueue(sessionId)
        setPaused(false)
      } else {
        await api.pauseSessionQueue(sessionId)
        setPaused(true)
      }
    } catch { /* non-fatal */ }
  }

  return (
    <div className={`border-t border-[var(--separator)] px-[var(--space-4)] bg-[var(--fill-quaternary)] shrink-0 ${collapsed ? 'py-[var(--space-1)]' : 'py-[var(--space-2)]'}`}>
      <div className={`flex items-center justify-between ${collapsed ? '' : 'mb-[var(--space-1)]'}`}>
        <button
          onClick={handleToggleCollapsed}
          title={collapsed ? 'Expand queue' : 'Collapse queue'}
          className="bg-transparent border-none cursor-pointer text-[var(--text-secondary)] p-0 flex items-center gap-[var(--space-1)]"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="text-[length:var(--text-caption2)] font-semibold uppercase tracking-[0.5px]">
            {pendingItems.length} queued {paused && '· Paused'}
          </span>
        </button>
        <div className="flex gap-[var(--space-1)]">
          <button
            onClick={handlePauseResume}
            title={paused ? 'Resume queue' : 'Pause queue'}
            className="bg-transparent border-none cursor-pointer text-[var(--text-secondary)] p-0.5 flex items-center"
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button
            onClick={handleClear}
            title="Clear all queued messages"
            className="bg-transparent border-none cursor-pointer text-[var(--text-secondary)] p-0.5 flex items-center"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-0.5">
          {pendingItems.map((item) => (
            <div key={item.id} className="flex items-center gap-[var(--space-2)] px-[var(--space-2)] py-[3px] rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)]">
              <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] min-w-4">
                {item.position}.
              </span>
              <span className="flex-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)] overflow-hidden text-ellipsis whitespace-nowrap">
                {item.prompt.length > 60 ? item.prompt.slice(0, 57) + '...' : item.prompt}
              </span>
              <button
                onClick={() => handleCancel(item.id)}
                title="Cancel this message"
                className="bg-transparent border-none cursor-pointer text-[var(--text-tertiary)] p-px flex items-center shrink-0"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
