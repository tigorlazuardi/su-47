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

export interface SukhoiConfig {
  /** Git clone URL of the target repository */
  repo: string;
  /** Branch to base feature branches on */
  baseBranch: string;
  /** System prompt for the AI coding agent */
  prompt: string;
  /** Plane state name mapping */
  states: StateNames;
  /** Worklog settings */
  worklog: WorklogConfig;
}

/**
 * Determine which model to use based on issue labels.
 *
 * Searches for labels containing "opus", "sonnet", or "haiku" (case insensitive).
 * Returns the full label name to use with `claude --model <label>`.
 *
 * Examples:
 * - Label "sonnet" → model "sonnet"
 * - Label "sonnet-4-5" → model "sonnet-4-5"
 * - Label "opus" → model "opus"
 * - No matching label → defaults to "sonnet"
 *
 * @returns The label name to use as model (defaults to "sonnet")
 */
export function resolveModelFromLabels(labels: PlaneLabel[]): string {
  const modelKeywords = ["opus", "sonnet", "haiku"];

  for (const label of labels) {
    const lowerName = label.name.toLowerCase();
    for (const keyword of modelKeywords) {
      if (lowerName.includes(keyword)) {
        return label.name;
      }
    }
  }

  return "sonnet";
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
