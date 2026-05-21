import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"

/**
 * Phase 2: current Organisation selection.
 *
 * - Loaded from GET /api/organisations once on mount.
 * - The active selection persists in localStorage so it survives reload.
 * - Defaults to the first Organisation (the Phase 1 first-boot migration
 *   creates a single "Default" Organisation; the operator renames it via
 *   the settings panel).
 * - When the active id is unknown (e.g. localStorage stale, fictional id from
 *   a test fixture), we keep the id but the API returns zero rows — confirms
 *   the filter works.
 */

export interface Organisation {
  id: string
  name: string
  leadEmployeeId: string | null
  wipCap: number
  createdAt: string
}

interface CurrentOrgValue {
  organisations: Organisation[]
  currentId: string | null
  current: Organisation | null
  setCurrentId: (id: string | null) => void
  isLoading: boolean
}

const STORAGE_KEY = "jinn:currentOrganisationId"

const CurrentOrgContext = createContext<CurrentOrgValue>({
  organisations: [],
  currentId: null,
  current: null,
  setCurrentId: () => {},
  isLoading: false,
})

export function CurrentOrganisationProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery<Organisation[]>({
    queryKey: ["organisations"],
    queryFn: async () => {
      const res = await fetch("/api/organisations")
      if (!res.ok) throw new Error(`Failed to load organisations: ${res.status}`)
      return res.json()
    },
    staleTime: 60_000,
  })

  const [currentId, setCurrentIdState] = useState<string | null>(() => {
    if (typeof window === "undefined") return null
    return window.localStorage.getItem(STORAGE_KEY)
  })

  // Once organisations load, seed the selection if none was persisted.
  useEffect(() => {
    if (!data || data.length === 0) return
    if (currentId && data.some((o) => o.id === currentId)) return
    // Default to the first Organisation.
    const next = data[0]?.id ?? null
    setCurrentIdState(next)
    if (next && typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next)
  }, [data, currentId])

  const setCurrentId = (id: string | null) => {
    setCurrentIdState(id)
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem(STORAGE_KEY, id)
      else window.localStorage.removeItem(STORAGE_KEY)
    }
  }

  const value = useMemo<CurrentOrgValue>(() => {
    const orgs = data ?? []
    const current = currentId ? orgs.find((o) => o.id === currentId) ?? null : null
    return {
      organisations: orgs,
      currentId,
      current,
      setCurrentId,
      isLoading,
    }
  }, [data, currentId, isLoading])

  return <CurrentOrgContext.Provider value={value}>{children}</CurrentOrgContext.Provider>
}

export function useCurrentOrganisation(): CurrentOrgValue {
  return useContext(CurrentOrgContext)
}

/**
 * Hook returning just the current organisation id, suitable as a React Query
 * key segment. `undefined` until the provider has finished loading — callers
 * should treat `undefined` as "don't fetch yet" via `enabled: orgId !== undefined`.
 */
export function useCurrentOrganisationId(): string | null | undefined {
  const { currentId, isLoading } = useCurrentOrganisation()
  if (isLoading) return undefined
  return currentId
}
