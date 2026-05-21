import { useCurrentOrganisation } from "@/context/current-organisation"
import { Building2, ChevronDown, Plus, Settings2, Trash2 } from "lucide-react"
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Organisation } from "@/lib/api"
import { queryKeys } from "@/lib/query-keys"
import { useOrg } from "@/hooks/use-employees"
import { cn } from "@/lib/utils"

/**
 * Phase 2 follow-up: full CRUD on Organisations.
 *
 * The switcher dropdown lists every Organisation, lets you switch between
 * them, opens a Create modal for new ones, and exposes a settings panel
 * on the active Org for rename / lead / WIP cap / delete.
 *
 * Delete refuses (server-side 409) when the Org has tasks or non-archived
 * sessions, so you can't accidentally lose work.
 *
 * `compact` collapses the label and shows only the icon — used when the
 * sidebar is in its narrow state.
 */
export function OrgSwitcher({ compact = false }: { compact?: boolean }) {
  const { organisations, current, currentId, setCurrentId, isLoading } = useCurrentOrganisation()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
        <Building2 size={14} />
        {!compact && <span>Loading...</span>}
      </div>
    )
  }

  const label = current?.name ?? "(no org)"

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs",
          "hover:bg-[var(--bg-tertiary)]",
          open && "bg-[var(--bg-tertiary)]",
        )}
        title={`Active Organisation: ${label}`}
        aria-label="Switch Organisation"
      >
        <Building2 size={14} className="shrink-0 text-muted-foreground" />
        {!compact && (
          <>
            <span className="truncate flex-1 text-left">{label}</span>
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[200]" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-[201] mt-1 min-w-[220px] rounded border border-border bg-[var(--bg-secondary)] py-1 shadow-lg">
            {organisations.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No Organisations yet.</div>
            ) : (
              organisations.map((org) => (
                <div key={org.id} className="group flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentId(org.id)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex flex-1 items-center justify-between gap-2 px-3 py-1.5 text-left text-xs",
                      "hover:bg-[var(--bg-tertiary)]",
                      org.id === currentId && "font-semibold text-foreground",
                    )}
                  >
                    <span className="truncate">{org.name}</span>
                    {org.id === currentId && <span className="text-muted-foreground">•</span>}
                  </button>
                  {org.id === currentId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpen(false)
                        setSettingsOpen(true)
                      }}
                      className="mr-1 rounded p-1 text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground"
                      aria-label="Organisation settings"
                      title="Settings"
                    >
                      <Settings2 size={12} />
                    </button>
                  )}
                </div>
              ))
            )}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setCreateOpen(true)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--bg-tertiary)]"
            >
              <Plus size={12} className="text-muted-foreground" />
              <span>New Organisation…</span>
            </button>
          </div>
        </>
      )}

      {createOpen && (
        <CreateOrganisationModal onClose={() => setCreateOpen(false)} onCreated={(org) => setCurrentId(org.id)} />
      )}
      {settingsOpen && current && (
        <OrganisationSettingsModal
          organisation={current}
          onClose={() => setSettingsOpen(false)}
          onDeleted={() => {
            setSettingsOpen(false)
            const remaining = organisations.filter((o) => o.id !== current.id)
            setCurrentId(remaining[0]?.id ?? null)
          }}
        />
      )}
    </div>
  )
}

// ── Create Organisation modal ─────────────────────────────────────────

function CreateOrganisationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (org: Organisation) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [wipCap, setWipCap] = useState(3)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (data: { name: string; wipCap: number }) => api.createOrganisation(data),
    onSuccess: (org) => {
      qc.invalidateQueries({ queryKey: queryKeys.organisations.all })
      onCreated(org)
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError("Name is required")
      return
    }
    mutation.mutate({ name: name.trim(), wipCap })
  }

  return (
    <Backdrop onClick={onClose}>
      <Panel onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-sm font-semibold">New Organisation</h3>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Engineering"
              className="rounded border border-border bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">WIP cap</span>
            <input
              type="number"
              min={1}
              value={wipCap}
              onChange={(e) => setWipCap(Math.max(1, Number(e.target.value) || 1))}
              className="w-24 rounded border border-border bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          {error && <div className="rounded bg-[color-mix(in_srgb,var(--system-red)_15%,transparent)] px-2 py-1 text-xs text-[var(--system-red)]">{error}</div>}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !name.trim()}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {mutation.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </Panel>
    </Backdrop>
  )
}

// ── Organisation settings modal ───────────────────────────────────────

function OrganisationSettingsModal({
  organisation,
  onClose,
  onDeleted,
}: {
  organisation: Organisation
  onClose: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const { data: org } = useOrg()
  const employees = org?.employees ?? []

  const [name, setName] = useState(organisation.name)
  const [leadEmployeeId, setLeadEmployeeId] = useState(organisation.leadEmployeeId ?? "")
  const [wipCap, setWipCap] = useState(organisation.wipCap)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; leadEmployeeId?: string | null; wipCap?: number }) =>
      api.updateOrganisation(organisation.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.organisations.all })
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteOrganisation(organisation.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.organisations.all })
      onDeleted()
    },
    onError: (err: Error) => setError(err.message),
  })

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    updateMutation.mutate({
      name: name.trim() || undefined,
      leadEmployeeId: leadEmployeeId === "" ? null : leadEmployeeId,
      wipCap,
    })
  }

  return (
    <Backdrop onClick={onClose}>
      <Panel onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-sm font-semibold">Organisation settings</h3>
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-border bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Lead employee</span>
            <select
              value={leadEmployeeId}
              onChange={(e) => setLeadEmployeeId(e.target.value)}
              className="rounded border border-border bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            >
              <option value="">— None (auto-picker idle) —</option>
              {employees.map((emp) => (
                <option key={emp.name} value={emp.name}>
                  {emp.displayName} ({emp.rank}) — {emp.department}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">WIP cap</span>
            <input
              type="number"
              min={1}
              value={wipCap}
              onChange={(e) => setWipCap(Math.max(1, Number(e.target.value) || 1))}
              className="w-24 rounded border border-border bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
          {error && <div className="rounded bg-[color-mix(in_srgb,var(--system-red)_15%,transparent)] px-2 py-1 text-xs text-[var(--system-red)]">{error}</div>}

          <div className="mt-2 flex items-center justify-between gap-2">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--system-red)] hover:bg-[color-mix(in_srgb,var(--system-red)_15%,transparent)]"
              >
                <Trash2 size={12} />
                Delete
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Delete this Organisation?</span>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="rounded bg-[var(--system-red)] px-2 py-1 font-semibold text-white"
                >
                  Yes, delete
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="rounded px-2 py-1 hover:bg-[var(--bg-tertiary)]">
                  Cancel
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)]">
                Cancel
              </button>
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {updateMutation.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </Panel>
    </Backdrop>
  )
}

// ── Tiny shared shells ────────────────────────────────────────────────

function Backdrop({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40"
    >
      {children}
    </div>
  )
}

function Panel({ children, onClick }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void }) {
  return (
    <div
      onClick={onClick}
      className="min-w-[320px] max-w-[420px] rounded-lg border border-border bg-[var(--bg-secondary)] p-4 shadow-xl"
    >
      {children}
    </div>
  )
}
