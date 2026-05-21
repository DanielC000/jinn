import { useCurrentOrganisation } from "@/context/current-organisation"
import { Building2, ChevronDown } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Phase 2: top-level Organisation switcher. Renders a single-button-style
 * dropdown listing all Organisations; selecting one persists the choice to
 * localStorage and refetches every Org-scoped query.
 *
 * Today there's only one Organisation ("Default" — created by the Phase 1
 * first-boot migration). The dropdown still renders so the wiring is real.
 *
 * `compact` collapses the label and shows only the icon — used when the
 * sidebar is in its narrow state.
 */
export function OrgSwitcher({ compact = false }: { compact?: boolean }) {
  const { organisations, current, currentId, setCurrentId, isLoading } = useCurrentOrganisation()
  const [open, setOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
        <Building2 size={14} />
        {!compact && <span>Loading...</span>}
      </div>
    )
  }

  if (organisations.length === 0) {
    return null
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
          <div className="absolute left-0 top-full z-[201] mt-1 min-w-[180px] rounded border border-border bg-[var(--bg-secondary)] py-1 shadow-lg">
            {organisations.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => {
                  setCurrentId(org.id)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs",
                  "hover:bg-[var(--bg-tertiary)]",
                  org.id === currentId && "font-semibold text-foreground",
                )}
              >
                <span className="truncate">{org.name}</span>
                {org.id === currentId && <span className="text-muted-foreground">•</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
