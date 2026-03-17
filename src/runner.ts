/**
 * runner.ts — Coding agent subprocess.
 *
 * Run via: bun run src/runner.ts
 *
 * Environment variables (set by worker):
 * - ISSUE_ID: Plane issue UUID
 * - PROJECT_ID: Plane project UUID
 * - MODEL: Claude model ID (e.g., claude-sonnet-4-20250514)
 * - PROMPT: Full prompt for the agent
 * - REPO: Git clone URL
 * - BASE_BRANCH: Branch to base feature branch on
 * - REPO_CACHE_DIR: Path to git repo cache
 * - GITHUB_TOKEN: GitHub PAT
 * - PROJECT_SLUG: Plane project slug (for branch naming)
 * - SEQUENCE_ID: Issue sequence number
 *
 * Outputs result.json with:
 * { prUrl?, commitUrl?, commitSha?, usage?, skipped, error? }
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerResult, RunnerUsage } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawn(cmd: string[], cwd: string): Promise<SpawnResult> {
  console.log(`[runner] Running: ${cmd.join(" ")} (cwd: ${cwd})`);

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`[runner] Command failed with exit code ${exitCode}`);
    console.error(`[runner] stdout: ${stdout}`);
    console.error(`[runner] stderr: ${stderr}`);
  }

  return { exitCode, stdout, stderr };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const result: RunnerResult = {
    skipped: false,
  };

  try {
    // Load env vars
    const issueId = requireEnv("ISSUE_ID");
    const model = requireEnv("MODEL");
    const prompt = requireEnv("PROMPT");
    const repo = requireEnv("REPO");
    const baseBranch = requireEnv("BASE_BRANCH");
    const repoCacheDir = requireEnv("REPO_CACHE_DIR");
    const githubToken = requireEnv("GITHUB_TOKEN");
    const projectSlug = requireEnv("PROJECT_SLUG");
    const sequenceId = requireEnv("SEQUENCE_ID");

    console.log(`[runner] Starting job for issue ${issueId}`);
    console.log(`[runner] Model: ${model}`);
    console.log(`[runner] Repo: ${repo}`);

    // 1. Authenticate GitHub
    console.log("[runner] Step 1: Authenticate GitHub");
    const ghAuth = Bun.spawn(["gh", "auth", "login", "--with-token"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    ghAuth.stdin.write(githubToken);
    ghAuth.stdin.end();
    await ghAuth.exited;

    if (ghAuth.exitCode !== 0) {
      throw new Error("GitHub authentication failed");
    }

    // 2. Configure git identity
    console.log("[runner] Step 2: Configure git identity");
    await spawn(["git", "config", "--global", "user.name", "su-47"], "/tmp");
    await spawn(["git", "config", "--global", "user.email", "su-47@localhost"], "/tmp");

    // 3. Manage repo cache
    console.log("[runner] Step 3: Manage repo cache");
    const repoDir = join(repoCacheDir, "repo");

    if (!existsSync(repoDir)) {
      console.log("[runner] Cache empty, cloning repository...");
      mkdirSync(repoCacheDir, { recursive: true });
      const cloneResult = await spawn(["git", "clone", repo, repoDir], repoCacheDir);
      if (cloneResult.exitCode !== 0) {
        throw new Error("Git clone failed");
      }
    } else {
      console.log("[runner] Cache exists, fetching updates...");
      const fetchResult = await spawn(["git", "fetch", "--all"], repoDir);
      if (fetchResult.exitCode !== 0) {
        console.warn("[runner] Git fetch failed, destroying cache and re-cloning...");
        rmSync(repoDir, { recursive: true, force: true });
        const cloneResult = await spawn(["git", "clone", repo, repoDir], repoCacheDir);
        if (cloneResult.exitCode !== 0) {
          throw new Error("Git clone failed");
        }
      } else {
        await spawn(["git", "reset", "--hard", `origin/${baseBranch}`], repoDir);
        await spawn(["git", "clean", "-fdx"], repoDir);
      }
    }

    // 4. Create git worktree
    console.log("[runner] Step 4: Create git worktree");
    const branchName = `fix/${projectSlug}-${sequenceId}`;
    const worktreeDir = join(repoCacheDir, "worktree");

    if (existsSync(worktreeDir)) {
      rmSync(worktreeDir, { recursive: true, force: true });
    }

    const worktreeResult = await spawn(
      ["git", "worktree", "add", "-b", branchName, worktreeDir, `origin/${baseBranch}`],
      repoDir,
    );

    if (worktreeResult.exitCode !== 0) {
      throw new Error("Git worktree creation failed");
    }

    // 5. Install dependencies
    console.log("[runner] Step 5: Install dependencies");
    let installCmd: string[] = ["bun", "install", "--frozen-lockfile"];

    if (existsSync(join(worktreeDir, "pnpm-lock.yaml"))) {
      installCmd = ["pnpm", "install", "--frozen-lockfile"];
    } else if (existsSync(join(worktreeDir, "yarn.lock"))) {
      installCmd = ["yarn", "install", "--frozen-lockfile"];
    } else if (existsSync(join(worktreeDir, "package-lock.json"))) {
      installCmd = ["npm", "ci"];
    }

    const installResult = await spawn(installCmd, worktreeDir);
    if (installResult.exitCode !== 0) {
      console.warn("[runner] Dependency installation failed, continuing anyway...");
    }

    // 6. Run claude agent
    console.log("[runner] Step 6: Run claude agent");
    const claudeResult = await spawn(
      ["claude", "-p", "--model", model, "--output-format", "stream-json", prompt],
      worktreeDir,
    );

    if (claudeResult.exitCode !== 0) {
      throw new Error(`Claude agent failed: ${claudeResult.stderr}`);
    }

    // 7. Parse usage from stream-json output
    console.log("[runner] Step 7: Parse usage");
    const usage = parseUsage(claudeResult.stdout);
    if (usage) {
      result.usage = usage;
    }

    // 8. Check for changes
    console.log("[runner] Step 8: Check for changes");
    const statusResult = await spawn(["git", "status", "--porcelain"], worktreeDir);
    const hasChanges = statusResult.stdout.trim().length > 0;

    if (!hasChanges) {
      console.log("[runner] No changes detected, skipping commit");
      result.skipped = true;
      return;
    }

    // 9. Commit changes
    console.log("[runner] Step 9: Commit changes");
    await spawn(["git", "add", "-A"], worktreeDir);
    const commitMsg = `fix: ${projectSlug}-${sequenceId}`;
    const commitResult = await spawn(["git", "commit", "-m", commitMsg], worktreeDir);

    if (commitResult.exitCode !== 0) {
      throw new Error("Git commit failed");
    }

    // Get commit SHA
    const shaResult = await spawn(["git", "rev-parse", "HEAD"], worktreeDir);
    result.commitSha = shaResult.stdout.trim();

    // 10. Push + create PR
    console.log("[runner] Step 10: Push branch and create PR");
    const pushResult = await spawn(["git", "push", "-u", "origin", branchName], worktreeDir);

    if (pushResult.exitCode !== 0) {
      throw new Error("Git push failed");
    }

    const prResult = await spawn(
      [
        "gh",
        "pr",
        "create",
        "--base",
        baseBranch,
        "--head",
        branchName,
        "--title",
        commitMsg,
        "--body",
        `Automated fix for issue ${projectSlug}-${sequenceId}\n\nPlane issue: ${issueId}`,
      ],
      worktreeDir,
    );

    if (prResult.exitCode !== 0) {
      throw new Error(`PR creation failed: ${prResult.stderr}`);
    }

    // Extract PR URL from gh output
    result.prUrl = prResult.stdout.trim();

    // Build commit URL
    const repoName = repo.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "");
    result.commitUrl = `https://github.com/${repoName}/commit/${result.commitSha}`;

    console.log(`[runner] PR created: ${result.prUrl}`);
    console.log(`[runner] Commit: ${result.commitUrl}`);

    // 11. Cleanup worktree
    console.log("[runner] Step 11: Cleanup worktree");
    await spawn(["git", "worktree", "remove", worktreeDir, "--force"], repoDir);
  } catch (err) {
    console.error("[runner] Error:", err);
    result.error = String(err);
  } finally {
    // 12. Write result.json
    const resultPath = join(process.cwd(), "result.json");
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(`[runner] Wrote result to ${resultPath}`);
  }
}

// ---------------------------------------------------------------------------
// Usage Parser
// ---------------------------------------------------------------------------

function parseUsage(streamJsonOutput: string): RunnerUsage | null {
  try {
    // Stream-json format: one JSON object per line
    const lines = streamJsonOutput.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    // Parse the last line (final summary)
    const lastLine = lines[lines.length - 1];
    const data = JSON.parse(lastLine);

    // Extract usage fields (adapt to actual claude CLI output format)
    const usage = data.usage;
    if (!usage) return null;

    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: calculateCost(usage),
    };
  } catch (err) {
    console.warn("[runner] Failed to parse usage:", err);
    return null;
  }
}

function calculateCost(usage: any): number {
  // Placeholder cost calculation (adapt to actual pricing)
  const inputCost = (usage.input_tokens ?? 0) * 0.000003;
  const outputCost = (usage.output_tokens ?? 0) * 0.000015;
  const cacheReadCost = (usage.cache_read_input_tokens ?? 0) * 0.0000003;
  const cacheWriteCost = (usage.cache_creation_input_tokens ?? 0) * 0.0000037;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[runner] Fatal error:", err);
  process.exit(1);
});
