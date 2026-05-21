import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { queryKeys } from "@/lib/query-keys"
import { api, type Task, type TaskPriority, type TaskStatus } from "@/lib/api"
import { useCurrentOrganisationId } from "@/context/current-organisation"

/**
 * Phase 4 task hooks. Backed by the Phase 3 backend CRUD endpoints. The cache
 * partitions by current Organisation id so switching orgs forces a refetch.
 */

export function useTasks() {
  const orgId = useCurrentOrganisationId()
  return useQuery({
    queryKey: queryKeys.tasks.all(orgId),
    queryFn: () => api.getTasks(orgId!),
    enabled: !!orgId,
  })
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id!),
    queryFn: () => api.getTask(id!),
    enabled: !!id,
  })
}

export function useCreateTask() {
  const qc = useQueryClient()
  const orgId = useCurrentOrganisationId()
  return useMutation({
    mutationFn: (data: {
      title: string
      description?: string
      priority?: TaskPriority
      status?: TaskStatus
      supersedesTaskId?: string | null
    }) => {
      if (!orgId) throw new Error("No active Organisation")
      return api.createTask(orgId, data)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.root }),
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateTask>[1] }) =>
      api.updateTask(id, data),
    onSuccess: (task: Task) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.root })
      qc.setQueryData(queryKeys.tasks.detail(task.id), task)
    },
  })
}

export function useCloseTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.closeTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.root }),
  })
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.root }),
  })
}

export function useRedispatchTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.redispatchTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks.root }),
  })
}
