// Phase 2: keys partition by current Organisation id when relevant, so switching
// organisations forces a refetch and the cache doesn't bleed across orgs.
export const queryKeys = {
  organisations: {
    all: ['organisations'] as const,
  },
  sessions: {
    /** All keys at the sessions root — pass without orgId to invalidate every org. */
    root: ['sessions'] as const,
    all: (orgId?: string | null) => (orgId ? (['sessions', { orgId }] as const) : (['sessions'] as const)),
    search: (q: string, orgId?: string | null) =>
      orgId ? (['sessions', 'search', q, { orgId }] as const) : (['sessions', 'search', q] as const),
    detail: (id: string) => ['sessions', id] as const,
    children: (id: string) => ['sessions', id, 'children'] as const,
    transcript: (id: string) => ['sessions', id, 'transcript'] as const,
    queue: (id: string) => ['sessions', id, 'queue'] as const,
  },
  org: {
    root: ['org'] as const,
    all: (orgId?: string | null) => (orgId ? (['org', { orgId }] as const) : (['org'] as const)),
    employee: (name: string) => ['org', 'employees', name] as const,
    board: (dept: string) => ['org', 'departments', dept, 'board'] as const,
  },
  cron: {
    root: ['cron'] as const,
    all: (orgId?: string | null) => (orgId ? (['cron', { orgId }] as const) : (['cron'] as const)),
    runs: (id: string) => ['cron', id, 'runs'] as const,
  },
  skills: {
    root: ['skills'] as const,
    all: (orgId?: string | null) => (orgId ? (['skills', { orgId }] as const) : (['skills'] as const)),
    detail: (name: string) => ['skills', name] as const,
  },
  tasks: {
    root: ['tasks'] as const,
    all: (orgId?: string | null) => (orgId ? (['tasks', { orgId }] as const) : (['tasks'] as const)),
    detail: (id: string) => ['tasks', id] as const,
  },
  config: ['config'] as const,
  status: ['status'] as const,
} as const
