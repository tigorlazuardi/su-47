/**
 * types.ts — Single source of truth for all TypeScript interfaces in su-47.
 */

// ---------------------------------------------------------------------------
// Claude CLI Auth
// ---------------------------------------------------------------------------

/** Output shape of `claude auth status --json` */
export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

/** Active OAuth login subprocess (only one allowed at a time) */
export interface LoginSession {
  process: ReturnType<typeof Bun.spawn>;
  oauthUrl: string;
  createdAt: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Plane API
// ---------------------------------------------------------------------------

export interface PlaneLabel {
  id: string;
  name: string;
  color: string;
}

export interface PlaneState {
  id: string;
  name: string;
  group: string;
  color: string;
}

export interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  description_html?: string;
  description_stripped?: string;
  priority: string;
  state: string; // state UUID
  state_detail?: PlaneState;
  labels: string[]; // label UUIDs
  label_details?: PlaneLabel[];
  parent?: string; // parent issue UUID
  project: string; // project UUID
  created_at: string;
  updated_at: string;
}

export interface PlaneComment {
  id: string;
  comment_html: string;
  actor_detail?: {
    id: string;
    display_name: string;
    email: string;
  };
  created_at: string;
}

export interface PlaneWebhookPayload {
  event: "issue" | "comment" | string;
  action: "created" | "updated" | "deleted" | string;
  webhook_id: string;
  webhook_data: {
    id: string;
  };
  issue?: PlaneIssue;
  comment?: {
    id: string;
    body: string;
    issue: string; // issue UUID
    project: string; // project UUID
    actor: string;
  };
  project?: string; // project UUID
}

// ---------------------------------------------------------------------------
// Application Config (su-47.config.json)
// ---------------------------------------------------------------------------

/** Complexity keys are user-defined strings from config (e.g. "simple", "moderate", "complex") */
export type Complexity = string;

export interface ClassifierConfig {
  enabled: boolean;
  /** Model alias (key in `models`) used for classification */
  model: string;
  /** Map of complexity key → description shown to the classifier LLM */
  complexity: Record<Complexity, string>;
}

export interface WorklogConfig {
  enabled: boolean;
  /** Maximum number of worklog entries to prepend to the prompt */
  maxEntries: number;
}

export interface StateNames {
  todo: string;
  inProgress: string;
  done: string;
  failed: string;
}

export interface RoutingRule {
  /** Match if issue priority is in this list */
  priority?: string[];
  /** Match if issue has at least one label in this list */
  labels?: string[];
  /** Match if classifier output is in this list */
  complexity?: Complexity[];
  /** Model alias to use when this rule matches */
  model: string;
}

export interface SukhoiConfig {
  /** Git clone URL of the target repository */
  repo: string;
  /** Branch to base feature branches on */
  baseBranch: string;
  /** System prompt for the AI coding agent */
  prompt: string;
  /** LLM complexity classifier settings */
  classifier: ClassifierConfig;
  /** Map of model alias → full model ID */
  models: Record<string, string>;
  /** Ordered routing rules (first match wins) */
  routing: RoutingRule[];
  /** Fallback model alias when no rule matches */
  defaultModel: string;
  /** Plane state name mapping */
  states: StateNames;
  /** Worklog settings */
  worklog: WorklogConfig;
}

// ---------------------------------------------------------------------------
// Job Queue
// ---------------------------------------------------------------------------

export type BunSubProcess = ReturnType<typeof Bun.spawn>;

export interface Job {
  id: string;
  issueId: string;
  projectId: string;
  process?: BunSubProcess;
  signal: AbortController;
}

// ---------------------------------------------------------------------------
// Runner result (written to result.json by src/runner.ts)
// ---------------------------------------------------------------------------

export interface RunnerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface RunnerResult {
  prUrl?: string;
  commitUrl?: string;
  commitSha?: string;
  usage?: RunnerUsage;
  /** True when the agent made no changes (nothing to commit) */
  skipped: boolean;
  error?: string;
}
