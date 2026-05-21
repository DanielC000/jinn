import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'
import { useCurrentOrganisationId } from '@/context/current-organisation'

export function useOrg() {
  const orgId = useCurrentOrganisationId()
  return useQuery({
    queryKey: queryKeys.org.all(orgId),
    queryFn: () => api.getOrg(orgId),
    enabled: orgId !== undefined,
  })
}

export function useEmployee(name: string | null) {
  return useQuery({
    queryKey: queryKeys.org.employee(name!),
    queryFn: () => api.getEmployee(name!),
    enabled: !!name,
  })
}

export function useDepartmentBoard(dept: string | null) {
  return useQuery({
    queryKey: queryKeys.org.board(dept!),
    queryFn: () => api.getDepartmentBoard(dept!),
    enabled: !!dept,
  })
}
