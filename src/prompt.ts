/**
 * prompt.ts — Prompt construction for the coding agent and Plane comments.
 */

import type { PlaneIssue, RunnerResult, SukhoiConfig } from "./types";

// ---------------------------------------------------------------------------
// Agent Prompt
// ---------------------------------------------------------------------------

/**
 * Build the full prompt for the coding agent.
 * Combines system prompt with task context.
 */
export function buildPrompt(config: SukhoiConfig, issue: PlaneIssue): string {
  const parts: string[] = [];

  // System prompt from config
  parts.push(config.prompt);
  parts.push("");
  parts.push("---");
  parts.push("");

  // Task context
  parts.push("## Task");
  parts.push("");
  parts.push(`**Title:** ${issue.name}`);
  parts.push("");

  if (issue.description_stripped) {
    parts.push("**Description:**");
    parts.push("");
    parts.push(issue.description_stripped);
    parts.push("");
  }

  // Priority
  if (issue.priority && issue.priority !== "none") {
    parts.push(`**Priority:** ${issue.priority}`);
    parts.push("");
  }

  // Labels
  if (issue.label_details && issue.label_details.length > 0) {
    const labels = issue.label_details.map((l) => l.name).join(", ");
    parts.push(`**Labels:** ${labels}`);
    parts.push("");
  }

  // State
  if (issue.state_detail) {
    parts.push(`**State:** ${issue.state_detail.name}`);
    parts.push("");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Plane Comments
// ---------------------------------------------------------------------------

/**
 * Build a comment for model selection.
 */
export function buildModelComment(model: string): string {
  return `🤖 **Model selected:** \`${model}\`\n\nStarting work...`;
}

/**
 * Build a comment for job queued notification.
 */
export function buildQueuedComment(position: number): string {
  if (position === 0) {
    return "⏳ **Job queued** — starting now...";
  }
  return `⏳ **Job queued** — position in queue: ${position + 1}`;
}

/**
 * Build a comment for job completion.
 */
export function buildCompletionComment(result: RunnerResult): string {
  const parts: string[] = [];

  if (result.skipped) {
    parts.push("✅ **Task completed** — no changes needed.");
    return parts.join("\n");
  }

  if (result.error) {
    parts.push("❌ **Task failed**");
    parts.push("");
    parts.push("```");
    parts.push(result.error);
    parts.push("```");
    return parts.join("\n");
  }

  parts.push("✅ **Task completed**");
  parts.push("");

  if (result.prUrl) {
    parts.push(`**Pull Request:** ${result.prUrl}`);
  }

  if (result.commitUrl) {
    parts.push(`**Commit:** ${result.commitUrl}`);
  }

  if (result.commitSha) {
    parts.push(`**SHA:** \`${result.commitSha}\``);
  }

  if (result.usage) {
    parts.push("");
    parts.push("**Usage:**");
    parts.push(`- Input tokens: ${result.usage.inputTokens.toLocaleString()}`);
    parts.push(`- Output tokens: ${result.usage.outputTokens.toLocaleString()}`);
    parts.push(`- Cache read tokens: ${result.usage.cacheReadTokens.toLocaleString()}`);
    parts.push(`- Cache write tokens: ${result.usage.cacheWriteTokens.toLocaleString()}`);
    parts.push(`- Cost: $${result.usage.costUsd.toFixed(4)}`);
  }

  return parts.join("\n");
}

/**
 * Build a comment for job cancellation.
 */
export function buildCancelledComment(): string {
  return "🛑 **Job cancelled** by `/cancel` command.";
}

/**
 * Build a comment for job timeout.
 */
export function buildTimeoutComment(timeoutMs: number): string {
  const minutes = Math.floor(timeoutMs / 60000);
  return `⏱️ **Job timed out** after ${minutes} minutes.`;
}
