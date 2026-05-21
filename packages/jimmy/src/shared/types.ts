export type StreamDeltaType = "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
}

export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

export interface InterruptibleEngine extends Engine {
  /** Kill a running engine process for a specific Jinn session. */
  kill(sessionId: string, reason?: string): void;
  /** Check if a live engine process is still running for this session. */
  isAlive(sessionId: string): boolean;
  /** Kill all live engine processes during gateway shutdown. */
  killAll(): void;
}

export function isInterruptibleEngine(engine: Engine): engine is InterruptibleEngine {
  return "kill" in engine && "isAlive" in engine && "killAll" in engine;
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  /** Extra CLI flags to pass to the engine binary (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** Path to MCP config JSON file (passed as --mcp-config to Claude Code) */
  mcpConfigPath?: string;
  onStream?: (delta: StreamDelta) => void;
  /** Unique Jinn session ID for tracking the spawned process. */
  sessionId?: string;
  /** Session source ("cron", "web", "slack", …) — used by the interactive engine for lifecycle policy. */
  source?: string;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
  /**
   * Optional rate limit metadata returned by an engine.
   * `resetsAt` is a Unix timestamp in seconds.
   */
  rateLimit?: EngineRateLimitInfo;
}

export interface EngineRateLimitInfo {
  status?: string;
  /** Unix timestamp in seconds */
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ConnectorCapabilities {
  threading: boolean;
  messageEdits: boolean;
  reactions: boolean;
  attachments: boolean;
}

export interface ConnectorHealth {
  status: "running" | "stopped" | "error" | "qr_pending";
  detail?: string;
  capabilities: ConnectorCapabilities;
}

export type ReplyContext = JsonObject;

export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getCapabilities(): ConnectorCapabilities;
  getHealth(): ConnectorHealth;
  reconstructTarget(replyContext: ReplyContext): Target;
  sendMessage(target: Target, text: string): Promise<string | void>;
  replyMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;
  setTypingStatus?(channelId: string, threadTs: string | undefined, status: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** Return the bound employee name, if any */
  getEmployee?(): string | undefined;
}

export interface IncomingMessage {
  connector: string;
  source: string;
  sessionKey: string;
  replyContext: ReplyContext;
  messageId?: string;
  channel: string;
  thread?: string;
  user: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
  transportMeta?: JsonObject;
}

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
  localPath?: string;
}

export interface Target {
  channel: string;
  thread?: string;
  messageTs?: string;
  replyContext?: ReplyContext;
}

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  replyContext: ReplyContext | null;
  messageId: string | null;
  transportMeta: JsonObject | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "error" | "waiting" | "interrupted" | "archived";
  effortLevel: string | null;
  totalCost: number;
  totalTurns: number;
  queueDepth?: number;
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
  // Auto-split mega-chats (Phase 1):
  /** ISO timestamp when this session was archived in favor of a successor; null when active. */
  archivedAt: string | null;
  /** Session id of the successor (the new chat that took over after archive). */
  archivedTo: string | null;
  /** Session id this session was spawned from via auto-split; null when this is an original. */
  archivedFrom: string | null;
  /** When set, injected via --append-system-prompt on every turn so the model has prior context without rehydrating the full transcript. */
  summaryPrompt: string | null;
  /** When true, auto-split logic skips this session even if it crosses thresholds. */
  autoSplitDisabled: boolean;
  /** Organisation this session belongs to. Becomes NOT NULL after phase 5; legacy rows are null. */
  organisationId: string | null;
  /** Task this session is bound to. Null = untracked session (sidebar-initiated). */
  taskId: string | null;
  /** Employee FK (parallel to legacy free-text `employee`). Dropped in phase 9. */
  employeeId: string | null;
  /**
   * Computed: true when this session has crossed the auto-split threshold and
   * is not yet archived/disabled. Surfaced by the API so the UI can render a
   * "consider archiving this chat" banner. Not stored.
   */
  autoSplitDue?: boolean;
  /**
   * Computed: which threshold fired when `autoSplitDue: true`. Lets the UI
   * write accurate banner copy (e.g. "this chat has 228 messages" vs.
   * "this chat's transcript is ~85K tokens"). Not stored.
   */
  autoSplitTrigger?: "messages" | "bytes";
  /**
   * Computed: rough token estimate (bytes/4) when the byte trigger fires.
   * Only present when `autoSplitTrigger === "bytes"`. Not stored.
   */
  autoSplitTokensEstimate?: number;
  /**
   * Computed: live message count for this session, surfaced alongside
   * autoSplitDue so the auto-split banner can render "this chat has N messages"
   * without a second round-trip. Only present when autoSplitDue was evaluated
   * (i.e. for non-archived, non-disabled sessions). Not stored.
   */
  messageCount?: number;
  /**
   * Computed: number of queue items in DB with status='pending' for this session.
   * Drives the resume-banner copy ("N message(s) queued"). Not stored.
   */
  resumablePendingCount?: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  employee?: string;
  prompt: string;
  delivery?: CronDelivery;
  /** Organisation this job runs under. Populated by the first-boot migration on existing jobs. */
  organisationId?: string;
  /**
   * How this job interacts with the task system:
   *   - "untracked"   — (default) spawn a one-shot session with no task_id, today's behavior.
   *   - "create-task" — on fire, create a task (Backlog or To Do per config) and stop.
   *   - "resume-task" — on fire, dispatch the prompt to taskId's lead session.
   */
  taskMode?: "untracked" | "create-task" | "resume-task";
  /** When taskMode = "resume-task", the task to resume. */
  taskId?: string;
}

/** Top-level container. A user has one or more Organisations and switches between them in the UI. */
export interface Organisation {
  id: string;
  name: string;
  /** Employee the auto-picker dispatches To Do tasks to. References Employee.name. */
  leadEmployeeId: string | null;
  /** Maximum number of tasks the auto-picker keeps in In Progress + Review concurrently. */
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
  /** Lead employee's session for this task. Set by the picker on dispatch. */
  leadSessionId: string | null;
  /** Optional link to the task this one replaces (e.g. "follow-up to closed task X"). */
  supersedesTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CronDelivery {
  connector: string;
  channel: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  /** Emoji icon for this employee (shown in sidebar, org chart, etc.) */
  emoji?: string;
  /** Extra CLI flags passed to the engine (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** MCP servers this employee needs. true = all global, false = none, string[] = specific servers */
  mcp?: boolean | string[];
  /** Max cost in USD for a single session. Overrides global config. */
  maxCostUsd?: number;
  /** Default effort level for sessions assigned to this employee */
  effortLevel?: string;
  /** Whether to notify the parent session when this employee's child session completes. Default: true */
  alwaysNotify?: boolean;
  /** Who this employee reports to. String = single parent. Array = primary + dotted-line (future). */
  reportsTo?: string | string[];
  /** Services this employee provides to the org */
  provides?: ServiceDeclaration[];
}

/** A service that an employee can provide to other employees/departments. */
export interface ServiceDeclaration {
  name: string;
  description: string;
}

/** A node in the resolved org tree. Wraps an Employee with computed hierarchy data. */
export interface OrgNode {
  employee: Employee;
  /** Resolved primary parent name (null = reports to root) */
  parentName: string | null;
  /** Names of direct reports */
  directReports: string[];
  /** Depth in tree (root = 0, root's reports = 1, etc.) */
  depth: number;
  /** Path from root to this node (excluding virtual root), e.g. ["pravko-lead", "pravko-writer"] */
  chain: string[];
}

/** Warning about a hierarchy issue. */
export interface OrgWarning {
  employee: string;
  type: "broken_ref" | "cycle" | "self_ref" | "cross_department" | "multiple_executives";
  message: string;
  /** The invalid reportsTo value that caused this warning */
  ref?: string;
}

/** The fully resolved org hierarchy. */
export interface OrgHierarchy {
  /** Root node name — executive employee name, or null if no executive YAML exists */
  root: string | null;
  /** All nodes keyed by employee name */
  nodes: Record<string, OrgNode>;
  /** Ordered list for flat iteration (topological/BFS order, root first) */
  sorted: string[];
  /** Any resolution warnings */
  warnings: OrgWarning[];
}

export interface Department {
  name: string;
  displayName: string;
  description: string;
}

/** Stdio-based MCP server (spawned as child process) */
export interface McpServerStdioConfig {
  /** Shell command to start the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the MCP server process */
  env?: Record<string, string>;
}

/** HTTP/SSE-based MCP server (remote URL) */
export interface McpServerUrlConfig {
  /** Transport type — Claude Code requires "sse" for URL-based servers */
  type?: "sse";
  /** URL of the MCP server (HTTP streamable or SSE transport) */
  url: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

/** MCP server config — either stdio (command) or URL-based */
export type McpServerConfig = McpServerStdioConfig | McpServerUrlConfig;

export interface McpGlobalConfig {
  browser?: {
    enabled: boolean;
    provider?: "playwright" | "puppeteer";
  };
  search?: {
    enabled: boolean;
    provider?: "brave";
    apiKey?: string;
  };
  fetch?: {
    enabled: boolean;
  };
  /** Custom MCP servers defined by the user */
  custom?: Record<string, (McpServerStdioConfig | McpServerUrlConfig) & { enabled?: boolean }>;
}

export interface WebConnectorConfig {}

export interface SlackConnectorConfig {
  /** Unique instance identifier (e.g. "slack-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  appToken: string;
  botToken: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface DiscordConnectorConfig {
  /** Unique instance identifier (e.g. "discord-vox") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken?: string;       // Make optional — not needed in proxy mode
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
  /** Only respond to messages in this channel */
  channelId?: string;
  /** Route messages from specific channels to remote Jinn instances */
  channelRouting?: Record<string, string>;
  /** URL of the primary Jinn instance to proxy Discord I/O through (secondary/remote mode) */
  proxyVia?: string;
}

export interface TelegramConnectorConfig {
  /** Unique instance identifier (e.g. "telegram-support") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken: string;
  allowFrom?: number[];
  ignoreOldMessagesOnBoot?: boolean;
  /** Speech-to-text settings forwarded from top-level `config.stt` */
  stt?: {
    enabled?: boolean;
    model?: string;
    language?: string;
    languages?: string[];
  };
}

export interface WhatsAppConnectorConfig {
  /** Unique instance identifier (e.g. "whatsapp-main") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  /** Where to store session credentials (default: JINN_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow all */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
}

export interface ConnectorInstance {
  /** Unique instance ID */
  id: string;
  /** Connector type */
  type: "discord" | "discord-remote" | "slack" | "whatsapp" | "telegram";
  /** Employee to bind to this connector */
  employee?: string;
  /** Type-specific configuration */
  [key: string]: unknown;
}

export interface PortalConfig {
  portalName?: string;
  operatorName?: string;
  language?: string;
  onboarded?: boolean;
}

export interface JinnConfig {
  jinn?: { version?: string };
  gateway: { port: number; host: string; streaming?: boolean };
  engines: {
    default: "claude" | "codex" | "gemini";
    claude: {
      bin: string;
      model: string;
      effortLevel?: string;
      childEffortOverride?: string;
      /** Max concurrent live PTYs across all sessions (CLI/xterm view only). Default 8. */
      maxLivePtys?: number;
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
    gemini?: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
  };
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
    telegram?: TelegramConnectorConfig;
    discord?: DiscordConnectorConfig;
    whatsapp?: WhatsAppConnectorConfig;
    /** Named connector instances — allows multiple connectors of the same type */
    instances?: ConnectorInstance[];
  };
  logging: { file: boolean; stdout: boolean; level: string };
  mcp?: McpGlobalConfig;
  sessions?: {
    maxDurationMinutes?: number;
    maxCostUsd?: number;
    interruptOnNewMessage?: boolean;
    /**
     * On gateway startup, automatically re-dispatch every pending web queue item
     * from a prior run. Default: **false** — pending items stay resumable per-session
     * via the chat banner / sidebar Interrupted group. Set true to restore pre-v0.13.4
     * behavior (mass auto-resume on boot).
     */
    autoResumeOnBoot?: boolean;
    /**
     * Auto-split mega-chats: when a long-running session crosses a threshold,
     * archive it and continue in a fresh successor session seeded with a
     * compact summary (carried via --append-system-prompt). Keeps per-turn
     * token cost flat on long-running coordination chats.
     */
    autoSplit?: {
      /** Feature kill-switch. Default: true. */
      enabled?: boolean;
      /** Trigger after this many messages on a single session. Default: 100. */
      triggerMessages?: number;
      /** Or earlier if the transcript byte-estimate (chars/4) exceeds this. Default: 80000. */
      triggerTokensEstimate?: number;
      /**
       * What to do when the threshold is crossed:
       *   - "prompt"   — surface autoSplitDue=true in the session API so the
       *                  UI can render a banner; user manually triggers the
       *                  archive endpoint. (default — safest)
       *   - "silent"   — auto-trigger archive on the next turn. Friendlier
       *                  but lossier if the summary is bad.
       *   - "disabled" — feature off globally (same as enabled=false).
       */
      mode?: "prompt" | "silent" | "disabled";
      /** Model used for the summarization pass. Default: "sonnet". */
      summarizerModel?: string;
      /**
       * Per-rank threshold overrides. High-volume roles (executives, managers)
       * accumulate messages much faster than ICs because they receive
       * notification-style replies from their direct reports. Set lower triggers
       * here so their chats archive sooner.
       *
       * Built-in defaults (applied when a rank entry is omitted):
       *   executive → triggerMessages: 60
       *   manager   → triggerMessages: 60
       *   senior    → triggerMessages: 80
       *   employee  → (uses global triggerMessages)
       *
       * Resolution order: per-rank override → global → AUTO_SPLIT_DEFAULTS.
       */
      perRank?: {
        executive?: { triggerMessages?: number; triggerTokensEstimate?: number };
        manager?: { triggerMessages?: number; triggerTokensEstimate?: number };
        senior?: { triggerMessages?: number; triggerTokensEstimate?: number };
        employee?: { triggerMessages?: number; triggerTokensEstimate?: number };
      };
    };
    /** What to do when Claude hits a usage/rate limit. Default: "wait" (no automatic engine switch). Set to "fallback" to opt in to switching to Codex while Claude resets. */
    rateLimitStrategy?: "wait" | "fallback";
    /** Engine to use when rateLimitStrategy="fallback". Default: "codex" */
    fallbackEngine?: "codex";
  };
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
    /** If a cron job takes longer than this (ms), post a latency warning to the alert channel. Default: 300000 (5 min). */
    alertThresholdMs?: number;
  };
  notifications?: {
    connector?: string;  // defaults to "discord"
    channel?: string;    // Discord channel ID for admin notifications
  };
  portal?: PortalConfig;
  context?: {
    /** Max characters for the built system prompt. Defaults to 100000. */
    maxChars?: number;
  };
  stt?: {
    enabled?: boolean;
    model?: string;
    /** @deprecated Use `languages` instead. Kept for backwards compat. */
    language?: string;
    languages?: string[];
  };
  remotes?: Record<string, { url: string; label?: string }>;
}
