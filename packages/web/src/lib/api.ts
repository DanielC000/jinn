export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
  reportsTo?: string | string[];
  parentName?: string | null;
  directReports?: string[];
  depth?: number;
  chain?: string[];
}

export interface OrgWarning {
  employee: string;
  type: string;
  message: string;
  ref?: string;
}

export interface OrgHierarchy {
  root: string | null;
  sorted: string[];
  warnings: OrgWarning[];
}

export interface OrgData {
  departments: string[];
  employees: Employee[];
  hierarchy: OrgHierarchy;
}

export interface Organisation {
  id: string;
  name: string;
  leadEmployeeId: string | null;
  wipCap: number;
  createdAt: string;
}

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in-progress"
  | "waiting"
  | "review"
  | "done"
  | "stalled";

export type TaskPriority = "low" | "med" | "high";

export interface Task {
  id: string;
  organisationId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  leadSessionId: string | null;
  supersedesTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/**
 * Helper: append `organisation=<id>` to a URL. Existing query string is preserved.
 * Returns the URL unchanged when no organisationId is provided so consumers can
 * pass `undefined` to opt out of filtering.
 */
function withOrg(path: string, organisationId?: string | null): string {
  if (!organisationId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}organisation=${encodeURIComponent(organisationId)}`;
}

const BASE =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:7777";

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body.error) return String(body.error);
    if (body.message) return String(body.message);
  } catch {
    // Response wasn't JSON — fall through
  }
  return `API error: ${res.status}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

export interface SessionsResponse {
  /** Top-N most-recent sessions per group (employee / direct / cron). */
  sessions: Record<string, unknown>[]
  /** Total session count per group key, so the UI can show accurate "+N more". */
  counts: Record<string, number>
  /** How many per group the server returned (the load-more threshold). */
  perGroup: number
}

export const api = {
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  /** Phase 2: list Organisations. */
  getOrganisations: () => get<Organisation[]>("/api/organisations"),
  /** Phase 6: update an Organisation (name, lead, wip cap). */
  updateOrganisation: (id: string, data: { name?: string; leadEmployeeId?: string | null; wipCap?: number }) => {
    return fetch(`${BASE}/api/organisations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(async (res) => {
      if (!res.ok) throw new Error(await extractErrorMessage(res));
      return res.json() as Promise<Organisation>;
    });
  },
  /** Phase 6: redispatch a stalled task back to To Do. */
  redispatchTask: (id: string) =>
    post<Task>(`/api/tasks/${encodeURIComponent(id)}/redispatch`, {}),
  getSessions: (organisationId?: string | null) =>
    get<SessionsResponse>(withOrg("/api/sessions", organisationId)),
  /** One group's sessions, newest first — used by the sidebar "load more" button. */
  getSessionsForGroup: (group: string, offset: number, limit = 50, organisationId?: string | null) =>
    get<Record<string, unknown>[]>(
      withOrg(
        `/api/sessions?group=${encodeURIComponent(group)}&offset=${offset}&limit=${limit}`,
        organisationId,
      ),
    ),
  /** Search across ALL sessions (title / employee / id), newest first. */
  searchSessions: (query: string, organisationId?: string | null) =>
    get<Record<string, unknown>[]>(withOrg(`/api/sessions?q=${encodeURIComponent(query)}`, organisationId)),
  getSession: (id: string) => get<Record<string, unknown>>(`/api/sessions/${id}`),
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  updateSession: (id: string, data: { title?: string; autoSplitDisabled?: boolean }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/duplicate`, {}),
  archiveSession: (id: string, data?: { summary?: string; summarizerModel?: string }) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/archive`, data ?? {}),
  setAutoSplitDisabled: (id: string, disabled: boolean) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, { autoSplitDisabled: disabled }),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/stop`, {}),
  resumeSession: (id: string) =>
    post<{ status: string; sessionId: string; dispatched: number }>(`/api/sessions/${id}/resume`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  getCronJobs: (organisationId?: string | null) =>
    get<Record<string, unknown>[]>(withOrg("/api/cron", organisationId)),
  getCronRuns: (id: string) => get<Record<string, unknown>[]>(`/api/cron/${id}/runs`),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  triggerCronJob: (id: string) =>
    post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getOrg: (organisationId?: string | null) => get<OrgData>(withOrg("/api/org", organisationId)),
  // ── Tasks (Phase 3+) ────────────────────────────────────────────
  getTasks: (organisationId: string, status?: TaskStatus) =>
    get<Task[]>(`/api/organisations/${encodeURIComponent(organisationId)}/tasks${status ? `?status=${status}` : ""}`),
  createTask: (
    organisationId: string,
    data: {
      title: string;
      description?: string;
      priority?: TaskPriority;
      status?: TaskStatus;
      supersedesTaskId?: string | null;
    },
  ) =>
    post<Task>(`/api/organisations/${encodeURIComponent(organisationId)}/tasks`, data),
  getTask: (id: string) => get<Task>(`/api/tasks/${encodeURIComponent(id)}`),
  updateTask: (
    id: string,
    data: {
      title?: string;
      description?: string;
      priority?: TaskPriority;
      status?: TaskStatus;
      leadSessionId?: string | null;
    },
  ) => {
    // Use PATCH for partial updates (matches the backend endpoint).
    return fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(async (res) => {
      if (!res.ok) throw new Error(await extractErrorMessage(res));
      return res.json() as Promise<Task>;
    });
  },
  closeTask: (id: string) => post<Task>(`/api/tasks/${encodeURIComponent(id)}/close`, {}),
  deleteTask: (id: string) => del<{ status: string }>(`/api/tasks/${encodeURIComponent(id)}`),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  getDepartmentBoard: (name: string) =>
    get<Record<string, unknown>>(`/api/org/departments/${name}/board`),
  getSkills: () => get<Record<string, unknown>[]>("/api/skills"),
  getSkill: (name: string) => get<Record<string, unknown>>(`/api/skills/${name}`),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<Record<string, unknown>>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
  getActivity: () =>
    get<Array<{ event: string; payload: unknown; ts: number }>>("/api/activity"),
  updateDepartmentBoard: (name: string, data: unknown) =>
    put<Record<string, unknown>>(`/api/org/departments/${name}/board`, data),
  sttStatus: () =>
    get<{ available: boolean; model: string | null; downloading: boolean; progress: number; languages: string[] }>("/api/stt/status"),
  sttDownload: () =>
    post<{ status: string; model: string }>("/api/stt/download", {}),
  sttTranscribe: async (audioBlob: Blob, language?: string): Promise<{ text: string }> => {
    const params = language ? `?language=${encodeURIComponent(language)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); // 5 min timeout
    try {
      const res = await fetch(`${BASE}/api/stt/transcribe${params}`, {
        method: "POST",
        headers: { "Content-Type": audioBlob.type || "audio/webm" },
        body: audioBlob,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Transcription timed out (5 min)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  sttUpdateConfig: (languages: string[]) =>
    put<{ status: string; languages: string[] }>("/api/stt/config", { languages }),
  getSessionQueue: (id: string) =>
    get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) =>
    del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  clearSessionQueue: (sessionId: string) =>
    del<{ status: string; cancelled: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),
  uploadFile: async (file: File): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(await extractErrorMessage(res))
    return res.json()
  },
};
