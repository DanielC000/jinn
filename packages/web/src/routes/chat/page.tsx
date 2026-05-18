import React, { useState, useCallback, useEffect, useRef, useMemo, Suspense } from 'react'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { ChatTabBar } from '@/components/chat/chat-tabs'
import { ChatPane } from '@/components/chat/chat-pane'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import { useChatTabs } from '@/hooks/use-chat-tabs'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { useDeleteSession, useDuplicateSession, useSessions } from '@/hooks/use-sessions'
import { clearIntermediateMessages } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'
import { useSettings } from '@/routes/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import { Check, Copy, EllipsisVertical, Trash2 } from 'lucide-react'
import { writeViewMode, type ViewMode } from '@/lib/view-mode'

class ChatErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ChatErrorBoundary]', error.message, '\nComponent stack:', info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <PageLayout>
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="text-lg font-semibold text-[var(--system-red)]">Chat crashed</p>
            <pre className="max-w-lg overflow-auto rounded-lg bg-[var(--bg-tertiary)] p-4 text-left text-xs text-muted-foreground">
              {this.state.error.message}{'\n'}{this.state.error.stack?.split('\n').slice(0, 5).join('\n')}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload() }}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              Reload
            </button>
          </div>
        </PageLayout>
      )
    }
    return this.props.children
  }
}

export default function ChatPageWrapper() {
  return (
    <ChatErrorBoundary>
      <Suspense fallback={
        <PageLayout>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </PageLayout>
      }>
        <ChatPage />
      </Suspense>
    </ChatErrorBoundary>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Jinn'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  // sessionMeta carries the sessionId it belongs to so the tab-label effect
  // can ignore stale meta from a previous session mid-switch (title flash fix).
  const [sessionMeta, setSessionMeta] = useState<{ sessionId: string; engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [employeeSessions, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('jinn-chat-sidebar-collapsed') === 'true'
    }
    return false
  })
  const toggleSidebar = useCallback(() => {
    // Mobile: toggle mobileView between sidebar and chat
    const isMobile = window.innerWidth < 1024
    if (isMobile) {
      setMobileView((prev) => (prev === 'sidebar' ? 'chat' : 'sidebar'))
    } else {
      setSidebarCollapsed((prev) => {
        const next = !prev
        localStorage.setItem('jinn-chat-sidebar-collapsed', String(next))
        return next
      })
    }
  }, [])
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  // Per-session KEEP ALIVE toggle (reflects the session's keep_alive flag)
  const [keepAlive, setKeepAlive] = useState(false)
  // Pending user message from new-chat send — passed to the new ChatPane so the user bubble appears before loadSession resolves
  const [pendingUserMessage, setPendingUserMessage] = useState<{ sessionId: string; message: Message } | null>(null)

  // Sync KEEP ALIVE state when the active session changes
  useEffect(() => {
    if (!selectedId) { setKeepAlive(false); return }
    let cancelled = false
    api.getSession(selectedId)
      .then((s) => { if (!cancelled) setKeepAlive(Boolean(s?.keepAlive)) })
      .catch(() => { /* ignore — leave default */ })
    return () => { cancelled = true }
  }, [selectedId])

  const toggleKeepAlive = useCallback(() => {
    if (!selectedId) return
    const next = !keepAlive
    setKeepAlive(next) // optimistic
    api.updateSession(selectedId, { keepAlive: next }).catch(() => {
      setKeepAlive(!next) // revert on failure
    })
  }, [selectedId, keepAlive])

  // Persist view mode per session
  const setAndPersistViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    if (selectedId) writeViewMode(selectedId, mode)
  }, [selectedId])

  // When the active session changes, sync viewMode with the per-session persisted value.
  // - Switching to an EXISTING session → load its stored mode.
  // - Switching to a FRESHLY CREATED session (nothing stored yet) → inherit the current
  //   local viewMode, so picking "CLI" on New Chat before sending opens the new session in CLI.
  // - Going back to New Chat (selectedId = null) → keep viewMode as-is (don't force chat).
  const viewModeRef = useRef(viewMode)
  useEffect(() => { viewModeRef.current = viewMode }, [viewMode])
  useEffect(() => {
    if (!selectedId) return
    const raw = typeof window !== 'undefined'
      ? window.localStorage.getItem(`jinn-view-mode-${selectedId}`)
      : null
    if (raw === 'cli' || raw === 'chat') {
      setViewMode(raw)
    } else {
      writeViewMode(selectedId, viewModeRef.current)
    }
  }, [selectedId])
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [focusTrigger, setFocusTrigger] = useState(0)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const chatTabs = useChatTabs()
  const deleteSessionMutation = useDeleteSession()
  const duplicateSessionMutation = useDuplicateSession()
  const sessionsQuery = useSessions()
  const qc = useQueryClient()
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
  const handleOrderComputed = useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])


  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu && !showSessionPicker) return
    function handleClick(e: MouseEvent) {
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
      if (showSessionPicker && sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setShowSessionPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu, showSessionPicker])

  const copyToClipboard = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setShowMoreMenu(false)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  // Update tab label/status when session meta changes.
  // Guarded by `sessionMeta.sessionId === selectedId` so we never cross-write
  // the previous session's meta onto the newly active tab during a switch
  // (ChatPane is `key={selectedId}` — it remounts and re-emits meta).
  const { updateTabStatus, closeTabBySessionId, reconcileTabs } = chatTabs
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    if (sessionMeta.sessionId !== selectedId) return
    updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
      employeeName: sessionMeta.employee || undefined,
    })
  }, [selectedId, sessionMeta, portalName, updateTabStatus])

  // Clear sessionMeta synchronously when the active session changes — the new
  // ChatPane will repopulate it via onSessionMetaChange once it loads. This
  // prevents the title-flash where the effect above would otherwise stamp the
  // OLD session's title onto the NEW tab between switch and ChatPane mount.
  useEffect(() => {
    setSessionMeta((current) => (current && current.sessionId !== selectedId ? null : current))
  }, [selectedId])

  // Subscribe to session lifecycle events so chat tabs reflect real-time
  // running/idle/error status, get their label updated on rename, and close
  // automatically when the underlying session is deleted (e.g. from sidebar
  // bulk-delete or another client). Without this, `status: 'running'` set by
  // handleSessionCreated never flips back, leaving a stale blue dot.
  useEffect(() => {
    const unsub = subscribe((event: string, payload: unknown) => {
      const p = (payload || {}) as { sessionId?: string; title?: string }
      const sid = p.sessionId
      if (!sid) return
      switch (event) {
        case 'session:started':
          updateTabStatus(sid, { status: 'running' })
          break
        case 'session:completed':
        case 'session:stopped':
          updateTabStatus(sid, { status: 'idle' })
          break
        case 'session:error':
          updateTabStatus(sid, { status: 'error' })
          break
        case 'session:deleted':
          closeTabBySessionId(sid)
          break
        case 'session:updated':
          // Gateway currently emits {sessionId} only — handle title defensively
          // in case future emitters carry it. Stale labels after rename are
          // also reconciled via the useSessions() effect below.
          if (p.title) updateTabStatus(sid, { label: p.title })
          break
      }
    })
    return unsub
  }, [subscribe, updateTabStatus, closeTabBySessionId])

  // Reconcile persisted tabs against the authoritative sessions list:
  //   - drop orphan tabs whose sessions were deleted while the app was closed
  //     (or by another client before our WS reconnected)
  //   - normalize stale `status: 'running'` (persists across reloads otherwise)
  //   - pick up renames the WS event didn't carry a title for
  useEffect(() => {
    const sessions = sessionsQuery.data as
      | Array<{ id: string; title?: string; status?: string; employee?: string }>
      | undefined
    if (!sessions) return
    reconcileTabs(sessions)
  }, [sessionsQuery.data, reconcileTabs])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  const handleSelect = useCallback(
    (id: string) => {
      newChatIntentRef.current = false
      setSelectedId(id)
      setMobileView('chat')
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
    },
    [chatTabs]
  )

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setSelectedId(null)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    setFocusTrigger(prev => prev + 1)
  }, [chatTabs])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !newChatIntentRef.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [selectedId, handleSelect]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await deleteSessionMutation.mutateAsync(id)
    } catch { /* sidebar may have already deleted it */ }
    if (selectedId === id) {
      setSelectedId(null)
      setSessionMeta(null)
    }
    clearIntermediateMessages(id)
    chatTabs.closeTab(chatTabs.tabs.findIndex(t => t.sessionId === id))
    setShowMoreMenu(false)
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [selectedId, chatTabs, deleteSessionMutation, qc])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(id) as { id?: string; title?: string; employee?: string }
      if (result?.id) {
        setSelectedId(result.id)
        chatTabs.openTab({
          sessionId: result.id,
          label: result.title || 'Duplicated Chat',
          status: 'idle',
          unread: false,
          pinned: true,
          employeeName: result.employee || undefined,
        })
        setShowMoreMenu(false)
        qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || 'Unknown error'}`)
    }
  }, [chatTabs, duplicateSessionMutation, qc])

  const handleDuplicateFromSidebar = useCallback((newSessionId: string) => {
    chatTabs.openTab({ sessionId: newSessionId, label: 'Duplicated Chat', status: 'idle', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string, pending?: Message) => {
    if (pending) setPendingUserMessage({ sessionId: newId, message: pending })
    setSelectedId(newId)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  // Clear pendingUserMessage when selectedId moves away from the session it was created for
  useEffect(() => {
    if (pendingUserMessage && pendingUserMessage.sessionId !== selectedId) {
      setPendingUserMessage(null)
    }
  }, [selectedId, pendingUserMessage])

  // Tag incoming meta with the sessionId it belongs to so consumers (e.g.
  // the tab-label effect) can ignore stale meta from a previous session.
  // We read selectedId via a ref so this callback stays stable.
  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  const handleSessionMetaChange = useCallback((meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => {
    const sid = selectedIdRef.current
    if (!sid) return
    setSessionMeta({ sessionId: sid, ...meta })
  }, [])

  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

  // Navigation helpers for keyboard shortcuts
  const navigateSession = useCallback((direction: 1 | -1) => {
    const { sessionIds } = sidebarOrderRef.current
    if (sessionIds.length === 0) return
    if (!selectedId) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const idx = sessionIds.indexOf(selectedId)
    if (idx === -1) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const next = (idx + direction + sessionIds.length) % sessionIds.length
    handleSelect(sessionIds[next])
  }, [selectedId, handleSelect])

  const cycleEmployee = useCallback(() => {
    const { employeeNames, employeeSessionMap } = sidebarOrderRef.current
    if (employeeNames.length === 0) return
    const currentEmployee = sessionMeta?.employee ?? null
    const currentIdx = currentEmployee ? employeeNames.indexOf(currentEmployee) : -1
    const nextIdx = (currentIdx + 1) % employeeNames.length
    const nextEmployee = employeeNames[nextIdx]
    const firstSession = employeeSessionMap[nextEmployee]?.[0]
    if (firstSession) handleSelect(firstSession)
  }, [sessionMeta, handleSelect])

  const copyChat = useCallback(async () => {
    if (!selectedId) return
    try {
      const session = await api.getSession(selectedId) as { messages?: Array<{ role: string; content: string }> }
      const messages = session.messages ?? []
      const text = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n')
      await navigator.clipboard.writeText(text)
      setCopiedField('chat')
      setTimeout(() => setCopiedField(null), 1500)
    } catch { /* silently fail */ }
  }, [selectedId])

  // Centralized keyboard shortcut registry
  const shortcuts = useMemo<ShortcutDef[]>(() => [
    { key: 'n', category: 'Actions', description: 'New chat', action: handleNewChat },
    { key: 'j', category: 'Navigation', description: 'Next session', action: () => navigateSession(1) },
    { key: 'k', category: 'Navigation', description: 'Previous session', action: () => navigateSession(-1) },
    { key: 'e', category: 'Navigation', description: 'Next employee', action: cycleEmployee },
    { key: 'Backspace', category: 'Actions', description: 'Delete session', action: () => { if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }, enabled: !!selectedId },
    { key: 'Delete', category: 'Actions', description: 'Delete session', action: () => { if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }, enabled: !!selectedId },
    { key: 'c', category: 'Actions', description: 'Copy chat', action: copyChat, enabled: !!selectedId },
    { key: 'Escape', category: 'Navigation', description: 'Close overlay', action: () => {
      if (showShortcutOverlay) setShowShortcutOverlay(false)
      else if (showMoreMenu) setShowMoreMenu(false)
    }},
    { key: '/', category: 'Actions', description: 'Focus chat', action: () => {
      const el = document.getElementById('chat-textarea')
      if (el) el.focus()
    }},
    { key: '?', category: 'Help', description: 'Keyboard shortcuts', action: () => setShowShortcutOverlay(v => !v) },
    { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action: () => {
      if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
    }},
    { key: '[', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Previous tab', action: () => chatTabs.prevTab() },
    { key: ']', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Next tab', action: () => chatTabs.nextTab() },
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      modifiers: ['meta' as const, 'alt' as const],
      category: 'Navigation' as const,
      description: `Tab ${i + 1}`,
      action: () => chatTabs.switchTab(i),
    })),
  ], [handleNewChat, navigateSession, cycleEmployee, copyChat, selectedId, showShortcutOverlay, showMoreMenu, chatTabs])

  useKeyboardShortcuts(shortcuts)

  // When active tab changes, sync selectedId
  useEffect(() => {
    if (chatTabs.activeTab && chatTabs.activeTab.sessionId !== selectedId) {
      setSelectedId(chatTabs.activeTab.sessionId)
      return
    }

    if (!chatTabs.activeTab && selectedId && !newChatIntentRef.current) {
      setSelectedId(null)
      setSessionMeta(null)
      setEmployeeSessions([])
    }
  }, [chatTabs.activeTab, selectedId])

  // More menu (shared between desktop tab bar and mobile header)
  const moreMenu = selectedId ? (
    <div ref={moreMenuRef} className="relative">
      <button
        onClick={() => setShowMoreMenu((v) => !v)}
        aria-label="More options"
        className="flex items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <EllipsisVertical className="size-[18px]" />
      </button>

      {showMoreMenu && (
        <div className="absolute right-0 top-full z-[200] mt-1 min-w-[220px] overflow-hidden rounded-[var(--radius-md)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          <button
            onClick={() => copyToClipboard(selectedId, 'id')}
            className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            Copy Session ID
          </button>
          {sessionMeta?.engineSessionId && (
            <button
              onClick={() => {
                const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
                copyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
              }}
              className="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              Copy CLI Resume Command
            </button>
          )}
          <button
            onClick={() => { if (selectedId) handleDuplicate(selectedId) }}
            disabled={duplicateSessionMutation.isPending}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Copy className="size-3.5" />
            <span className="flex-1">{duplicateSessionMutation.isPending ? 'Duplicating...' : 'Duplicate...'}</span>
          </button>
          <div className="my-0.5 border-t border-border" />
          <button
            onClick={() => { setShowMoreMenu(false); if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--system-red)] transition-colors hover:bg-accent"
          >
            <Trash2 className="size-3.5" />
            <span className="flex-1">Delete Session</span>
            <kbd className="font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
          </button>
        </div>
      )}
    </div>
  ) : null

  // Build toolbar actions to pass into tab bar (desktop only content)
  const toolbarActions = (
    <>
      <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5">
        <button
          onClick={() => setAndPersistViewMode('chat')}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-medium transition-all",
            viewMode === 'chat'
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          Chat
        </button>
        <button
          onClick={() => setAndPersistViewMode('cli')}
          className={cn(
            "rounded-full px-2.5 py-1 font-mono text-[11px] font-medium transition-all",
            viewMode === 'cli'
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          CLI
        </button>
      </div>

      {selectedId && (
        <button
          onClick={toggleKeepAlive}
          title="Keep the Claude session warm between turns"
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-medium transition-all",
            keepAlive
              ? "bg-[var(--accent)] text-white shadow-sm"
              : "bg-[var(--fill-tertiary)] text-muted-foreground hover:text-foreground"
          )}
        >
          KEEP ALIVE
        </button>
      )}

      <div className="hidden lg:block">{moreMenu}</div>

      {copiedField && (
        <div className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[var(--accent)]">
          <Check className="size-3" />
          Copied!
        </div>
      )}
    </>
  )

  return (
    <PageLayout mobileHeaderActions={moreMenu}>
      <div className="flex overflow-hidden h-full">
        <div
          className="hidden h-full shrink-0 overflow-hidden lg:block"
          style={{
            width: sidebarCollapsed ? 0 : 280,
            transition: 'width 200ms ease-in-out',
          }}
        >
          <div className="h-full w-[280px]">
            <ChatSidebar
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onDuplicate={handleDuplicateFromSidebar}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
            />
          </div>
        </div>

        <div className="min-w-0 flex-1 flex-col overflow-hidden bg-background flex">
          <ChatTabBar
            tabs={chatTabs.tabs}
            activeIndex={chatTabs.activeIndex}
            onSwitch={chatTabs.switchTab}
            onClose={chatTabs.closeTab}
            onNew={handleNewChat}
            onPin={chatTabs.pinTab}
            onMove={chatTabs.moveTab}
            toolbarActions={toolbarActions}
            sidebarCollapsed={mobileView === 'chat' || sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
          />

          <div
            className={mobileView === 'sidebar' ? 'flex-1 overflow-hidden lg:hidden' : 'hidden'}
          >
            <ChatSidebar
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onDuplicate={handleDuplicateFromSidebar}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
            />
          </div>

          <div className={cn(
            "flex-1 overflow-hidden flex flex-col",
            mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
          )}>
            {/* Single ChatPane: handles new-chat (sessionId=null) and the selected session.
                Keyed by selectedId so switching sessions remounts cleanly — no hidden
                keep-alive panes (they caused stacked WS subscriptions + races). */}
            <ChatPane
              key={selectedId ?? '__new__'}
              sessionId={selectedId}
              isActive={true}
              onFocus={() => {}}
              onSessionCreated={handleSessionCreated}
              onSessionMetaChange={handleSessionMetaChange}
              onRefresh={handleRefresh}
              portalName={portalName}
              subscribe={subscribe}
              connectionSeq={connectionSeq}
              skillsVersion={skillsVersion}
              events={events}
              viewMode={viewMode}
              focusTrigger={focusTrigger}
              onShortcutsClick={() => setShowShortcutOverlay(true)}
              pendingUserMessage={
                pendingUserMessage && pendingUserMessage.sessionId === selectedId
                  ? pendingUserMessage.message
                  : undefined
              }
            />
          </div>
        </div>
      </div>

      {showShortcutOverlay && (
        <ShortcutOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutOverlay(false)}
        />
      )}

    </PageLayout>
  )
}
