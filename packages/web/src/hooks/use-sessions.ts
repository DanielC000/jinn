import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api, type SessionsResponse } from '@/lib/api'
import { useCurrentOrganisationId } from '@/context/current-organisation'

// The query cache holds the full SessionsResponse; both hooks below select from
// the same cached object so there is only ever one network request per Organisation.
// Sidebar "load more" appends pages into `sessions` via queryClient.setQueryData.

export function useSessions() {
  const orgId = useCurrentOrganisationId()
  return useQuery({
    queryKey: queryKeys.sessions.all(orgId),
    queryFn: () => api.getSessions(orgId),
    select: (d: SessionsResponse) => d.sessions,
    enabled: orgId !== undefined,
  })
}

export function useSessionCounts() {
  const orgId = useCurrentOrganisationId()
  return useQuery({
    queryKey: queryKeys.sessions.all(orgId),
    queryFn: () => api.getSessions(orgId),
    select: (d: SessionsResponse) => ({ counts: d.counts, perGroup: d.perGroup }),
    enabled: orgId !== undefined,
  })
}

// Server-side search across ALL sessions (not just the loaded page). Enabled
// only when there's a query; results are short-lived since they reflect a search.
export function useSessionSearch(query: string) {
  const q = query.trim()
  const orgId = useCurrentOrganisationId()
  return useQuery({
    queryKey: queryKeys.sessions.search(q, orgId),
    queryFn: () => api.searchSessions(q, orgId),
    enabled: q.length > 0 && orgId !== undefined,
    staleTime: 10_000,
  })
}

export function useUpdateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string } }) =>
      api.updateSession(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.root }),
    onError: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.root }),
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.root }),
  })
}

export function useBulkDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSessions(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.root }),
  })
}

export function useDuplicateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.duplicateSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.root }),
  })
}
