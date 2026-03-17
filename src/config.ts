/**
 * config.ts — Environment variable loading and su-47.config.json loader with hot-reload.
 */

import { readFileSync, watch } from "node:fs";
import type { SukhoiConfig } from "./types";

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export interface Env {
  PORT: number;
  PLANE_API_KEY: string;
  PLANE_BASE_URL: string;
  PLANE_WORKSPACE_SLUG: string;
  PLANE_PROJECT_ID: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  CONCURRENCY: number;
  JOB_TIMEOUT_MS: number;
  REPO_CACHE_DIR: string;
  LOGIN_TIMEOUT_MS: number;
}

export function loadEnv(): Env {
  return {
    PORT: Number(optionalEnv("PORT", "3000")),
    PLANE_API_KEY: requireEnv("PLANE_API_KEY"),
    PLANE_BASE_URL: requireEnv("PLANE_BASE_URL"),
    PLANE_WORKSPACE_SLUG: requireEnv("PLANE_WORKSPACE_SLUG"),
    PLANE_PROJECT_ID: requireEnv("PLANE_PROJECT_ID"),
    WEBHOOK_SECRET: requireEnv("WEBHOOK_SECRET"),
    GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
    CONCURRENCY: Number(optionalEnv("CONCURRENCY", "1")),
    JOB_TIMEOUT_MS: Number(optionalEnv("JOB_TIMEOUT_MS", "1800000")),
    REPO_CACHE_DIR: optionalEnv("REPO_CACHE_DIR", "/repo-cache"),
    LOGIN_TIMEOUT_MS: Number(optionalEnv("LOGIN_TIMEOUT_MS", "300000")),
  };
}

// ---------------------------------------------------------------------------
// su-47.config.json loader
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.SU47_CONFIG_PATH ?? "su-47.config.json";

/** Default system prompt if not provided in config */
const DEFAULT_PROMPT = `You are an expert software engineer working on a task.

IMPORTANT: Before starting, read the project guidelines:
1. Look for AGENTS.md in the repository root
2. If AGENTS.md doesn't exist, look for CLAUDE.md instead
3. Follow all instructions and conventions specified in those files

After completing the task, you MUST provide a summary of your changes in the following format:

## Changes Summary

### Files Modified
- \`path/to/file1.ts\`: Brief description of what changed and why
- \`path/to/file2.ts\`: Brief description of what changed and why

### Files Created
- \`path/to/new-file.ts\`: Brief description of what this file does

### Files Deleted
- \`path/to/old-file.ts\`: Brief reason for deletion

If no changes were made, explain why:
- State the reason clearly (e.g., "No changes needed - the existing implementation already handles this case")

This summary will be included in:
1. Git commit message
2. GitHub pull request body
3. Plane issue comment

Format the summary in clear, concise markdown.`;

function parseConfig(raw: string): SukhoiConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${CONFIG_PATH}: ${err}`);
  }

  const cfg = parsed as Partial<SukhoiConfig>;

  // Validate required fields (prompt is now optional)
  const required: (keyof SukhoiConfig)[] = ["repo", "baseBranch", "states", "worklog"];
  for (const key of required) {
    if (cfg[key] === undefined) {
      throw new Error(`su-47.config.json missing required field: "${key}"`);
    }
  }

  // Use default prompt if not provided
  if (!cfg.prompt) {
    cfg.prompt = DEFAULT_PROMPT;
  }

  return cfg as SukhoiConfig;
}

export function loadConfig(): SukhoiConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${CONFIG_PATH}: ${err}`);
  }
  return parseConfig(raw);
}

/**
 * Watch su-47.config.json for changes and call `onChange` with the new config.
 * Errors during reload are logged but do not crash the process.
 * Returns an FSWatcher — call `.close()` to stop watching.
 */
export function watchConfig(onChange: (config: SukhoiConfig) => void): ReturnType<typeof watch> {
  const watcher = watch(CONFIG_PATH, { persistent: false }, (eventType) => {
    if (eventType !== "change" && eventType !== "rename") return;
    try {
      const updated = loadConfig();
      onChange(updated);
      console.log(`[config] Reloaded ${CONFIG_PATH}`);
    } catch (err) {
      console.error(`[config] Failed to reload ${CONFIG_PATH}:`, err);
    }
  });
  return watcher;
}

// ---------------------------------------------------------------------------
// Singleton exports (loaded once at startup by index.ts)
// ---------------------------------------------------------------------------

export const env: Env = loadEnv();
