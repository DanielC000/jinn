import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'
import { useCurrentOrganisationId } from '@/context/current-organisation'

export function useSkills() {
  const orgId = useCurrentOrganisationId()
  return useQuery({
    queryKey: queryKeys.skills.all(orgId),
    queryFn: () => api.getSkills(),
    enabled: orgId !== undefined,
  })
}

export function useSkill(name: string | null) {
  return useQuery({
    queryKey: queryKeys.skills.detail(name!),
    queryFn: () => api.getSkill(name!),
    enabled: !!name,
  })
}
