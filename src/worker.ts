/**
 * worker.ts — Job processor that spawns the runner subprocess.
 *
 * Flow:
 * 1. Fetch issue from Plane API
 * 2. Update state → "In Progress"
 * 3. Resolve model from labels
 * 4. Post model selection comment
 * 5. Build prompt
 * 6. Spawn runner subprocess
 * 7. Store subprocess ref in job
 * 8. Await subprocess with timeout
 * 9. Read result.json
 * 10. Update state → "Review/Testing" (success) or "Cancelled" (failure/timeout)
 * 11. Post completion comment
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./config";
import type { PlaneClient } from "./plane";
import {
  buildCompletionComment,
  buildModelComment,
  buildPrompt,
  buildTimeoutComment,
} from "./prompt";
import type { JobQueue } from "./queue";
import type { Job, RunnerResult, SukhoiConfig } from "./types";
import { resolveModelFromLabels } from "./types";

export interface WorkerContext {
  env: Env;
  config: SukhoiConfig;
  plane: PlaneClient;
  queue: JobQueue;
  inProgressStateId: string;
  doneStateId: string;
  failedStateId: string;
}

/**
 * Process a single job.
 * This is called by the queue when a slot opens.
 */
export async function processJob(job: Job, ctx: WorkerContext): Promise<void> {
  console.log(`[worker] Processing job ${job.id} for issue ${job.issueId}`);

  const resultPath = join(process.cwd(), "result.json");
  const timeoutMs = ctx.env.JOB_TIMEOUT_MS;

  try {
    // 1. Fetch issue from Plane API
    console.log(`[worker] Fetching issue ${job.issueId}`);
    const issue = await ctx.plane.getIssue(job.projectId, job.issueId);

    // 2. Update state → "In Progress"
    console.log(`[worker] Updating issue state to In Progress`);
    await ctx.plane.updateIssueState(job.projectId, job.issueId, ctx.inProgressStateId);

    // 3. Resolve model from labels
    const { label, modelId } = resolveModelFromLabels(issue.label_details ?? []);
    console.log(`[worker] Selected model: ${label} (${modelId})`);

    // 4. Post model selection comment
    await ctx.plane.addComment(job.projectId, job.issueId, buildModelComment(label, modelId));

    // 5. Build prompt
    const prompt = buildPrompt(ctx.config, issue);

    // 6. Spawn runner subprocess
    console.log(`[worker] Spawning runner subprocess`);

    // Extract project slug from issue (use project_id as fallback)
    const projectSlug = job.projectId.substring(0, 8);

    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "runner.ts")], {
      env: {
        ...process.env,
        ISSUE_ID: job.issueId,
        PROJECT_ID: job.projectId,
        MODEL: modelId,
        PROMPT: prompt,
        REPO: ctx.config.repo,
        BASE_BRANCH: ctx.config.baseBranch,
        REPO_CACHE_DIR: ctx.env.REPO_CACHE_DIR,
        GITHUB_TOKEN: ctx.env.GITHUB_TOKEN,
        PROJECT_SLUG: projectSlug,
        SEQUENCE_ID: String(issue.sequence_id),
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      cwd: process.cwd(),
    });

    // 7. Store subprocess ref in job
    ctx.queue.setProcess(job.id, proc);

    // 8. Await subprocess with timeout
    console.log(`[worker] Waiting for runner to complete (timeout: ${timeoutMs}ms)`);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Job timeout")), timeoutMs);
    });

    const exitPromise = proc.exited.then((code) => {
      if (code !== 0) {
        throw new Error(`Runner exited with code ${code}`);
      }
    });

    try {
      await Promise.race([exitPromise, timeoutPromise]);
    } catch (err) {
      // Timeout or non-zero exit
      if (String(err).includes("timeout")) {
        console.warn(`[worker] Job ${job.id} timed out, killing subprocess`);
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 10_000);

        // Update state → "Cancelled"
        await ctx.plane.updateIssueState(job.projectId, job.issueId, ctx.failedStateId);
        await ctx.plane.addComment(job.projectId, job.issueId, buildTimeoutComment(timeoutMs));
        return;
      }
      throw err;
    }

    // 9. Read result.json
    console.log(`[worker] Reading result.json`);
    let result: RunnerResult;

    if (!existsSync(resultPath)) {
      throw new Error("result.json not found");
    }

    try {
      const raw = readFileSync(resultPath, "utf8");
      result = JSON.parse(raw);
    } finally {
      // Clean up result.json
      rmSync(resultPath, { force: true });
    }

    // 10. Update state
    if (result.error) {
      console.error(`[worker] Job ${job.id} failed: ${result.error}`);
      await ctx.plane.updateIssueState(job.projectId, job.issueId, ctx.failedStateId);
    } else {
      console.log(`[worker] Job ${job.id} completed successfully`);
      await ctx.plane.updateIssueState(job.projectId, job.issueId, ctx.doneStateId);
    }

    // 11. Post completion comment
    await ctx.plane.addComment(job.projectId, job.issueId, buildCompletionComment(result));

    console.log(`[worker] Job ${job.id} finished`);
  } catch (err) {
    console.error(`[worker] Job ${job.id} error:`, err);

    // Update state → "Cancelled"
    try {
      await ctx.plane.updateIssueState(job.projectId, job.issueId, ctx.failedStateId);
      await ctx.plane.addComment(
        job.projectId,
        job.issueId,
        `❌ **Job failed**\n\n\`\`\`\n${String(err)}\n\`\`\``,
      );
    } catch (commentErr) {
      console.error(`[worker] Failed to post error comment:`, commentErr);
    }

    // Clean up result.json if exists
    if (existsSync(resultPath)) {
      rmSync(resultPath, { force: true });
    }
  }
}
