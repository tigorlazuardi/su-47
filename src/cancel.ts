/**
 * cancel.ts — Cancel a running job and update Plane issue state.
 *
 * Flow:
 * 1. Find active/pending job by issue ID
 * 2. Cancel job (SIGTERM → 10s → SIGKILL)
 * 3. Update Plane issue state → "Cancelled"
 * 4. Post comment: "Job cancelled by /cancel command"
 */

import type { PlaneClient } from "./plane";
import type { JobQueue } from "./queue";
import type { SukhoiConfig } from "./types";

export interface CancelContext {
  queue: JobQueue;
  plane: PlaneClient;
  config: SukhoiConfig;
  failedStateId: string;
}

/**
 * Cancel a job by issue ID.
 * Updates Plane state and posts a comment.
 */
export async function cancelJob(
  issueId: string,
  projectId: string,
  ctx: CancelContext,
): Promise<void> {
  console.log(`[cancel] Attempting to cancel job for issue ${issueId}`);

  // Try to cancel the job
  const cancelled = await ctx.queue.cancelByIssueId(issueId);

  if (!cancelled) {
    console.log(`[cancel] No active or pending job found for issue ${issueId}`);
    // Still post a comment to notify the user
    await ctx.plane.addComment(
      projectId,
      issueId,
      "❌ No active or pending job found for this issue.",
    );
    return;
  }

  console.log(`[cancel] Job cancelled for issue ${issueId}`);

  // Update Plane state → "Cancelled"
  try {
    await ctx.plane.updateIssueState(projectId, issueId, ctx.failedStateId);
    console.log(`[cancel] Updated issue ${issueId} state to Cancelled`);
  } catch (err) {
    console.error(`[cancel] Failed to update issue ${issueId} state:`, err);
  }

  // Post comment
  try {
    await ctx.plane.addComment(projectId, issueId, "🛑 Job cancelled by `/cancel` command.");
    console.log(`[cancel] Posted cancellation comment to issue ${issueId}`);
  } catch (err) {
    console.error(`[cancel] Failed to post comment to issue ${issueId}:`, err);
  }
}
