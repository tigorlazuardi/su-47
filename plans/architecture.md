# su-47 Architecture

## Overview

su-47 is a full rewrite of [sukhoi](https://github.com/tigorlazuardi/sukhoi) — an autonomous coding agent
that integrates Plane (project management) with Claude Code CLI. Key differences from sukhoi:

- **Runtime**: Bun.js instead of Node.js
- **Auth**: OAuth via web UI instead of raw API key (Claude Pro/Max subscription)
- **Runner**: TypeScript instead of Bash (`src/runner.ts` instead of `runner/entrypoint.sh`)
- **Cancel**: Plane comment `/cancel` kills the running agent subprocess

The web UI (OAuth flow) is protected by nginx. The `/webhook` endpoint is public but
validates the Plane webhook signature.

## What It Does

When a Plane issue is moved to "Todo":
1. su-47 receives the webhook
2. Classifies complexity (optional, via `claude -p`)
3. Routes to the appropriate model based on config rules
4. Spawns a `src/runner.ts` subprocess via `bun run`
5. Runner: clones repo, runs `claude` agent, commits, opens PR
6. Updates Plane issue state and posts comment with PR link

When a Plane issue receives a comment containing `/cancel`:
1. su-47 finds the active job matching that issue
2. Sends SIGTERM to the runner subprocess
3. Waits up to 10 seconds
4. If still running, sends SIGKILL
5. Updates Plane issue state to "Cancelled"

## Flow Diagrams

### Coding Agent Flow (Webhook → Job → PR)

```
Plane Issue → "Todo" state
     |
     v
POST /webhook (Plane webhook, public but HMAC-validated)
     |
     v
Signature Verification (HMAC-SHA256 of body, X-Plane-Signature header)
     |
     v
Event Filter (issue.updated, state == todoStateId)
     |
     v
JobQueue.enqueue() → post "queued" comment on Plane
     |
     v
Worker processes job:
  ├── Fetch full issue from Plane API
  ├── Update state → "In Progress"
  ├── Route model (rules + optional LLM classifier)
  ├── Post routing comment
  ├── Spawn `bun run src/runner.ts` subprocess
  │     ├── git clone/fetch (persistent cache + worktree)
  │     ├── bun install (dependencies)
  │     ├── claude -p --model $MODEL "$PROMPT"  (agent run)
  │     ├── git commit + push
  │     ├── gh pr create
  │     └── Write result.json
  ├── Read result.json
  └── Update state → "Review/Testing" or "Cancelled"
      Post completion comment (PR link, usage stats)
```

### Cancel Flow (Plane Comment → SIGTERM/SIGKILL)

```
Plane Issue receives comment "/cancel"
     |
     v
POST /webhook
     |
     v
Event Filter (comment.created, body starts with "/cancel")
     |
     v
Find active Job matching issue ID
     |
     ├── Not found → post comment "No active job for this issue"
     |
     └── Found:
           ├── Send SIGTERM to runner subprocess
           ├── Wait up to 10 seconds
           ├── If still alive → send SIGKILL
           ├── Update Plane state → "Cancelled"
           └── Post comment "Job cancelled"
```

### OAuth Login Flow (Web UI, behind nginx)

```
User                    su-47 Server              Claude CLI            claude.ai
 |                          |                         |                     |
 |-- GET / --------------->|                         |                     |
 |   (nginx basic auth)     |-- claude auth status -->|                     |
 |                          |<-- not logged in -------|                     |
 |<-- redirect /login ------|                         |                     |
 |                          |                         |                     |
 |-- GET /login ---------->|                         |                     |
 |                          |-- spawn claude auth login -->|               |
 |                          |<-- stdout: OAuth URL ---|                     |
 |<-- HTML page:            |   (parse, strip ANSI)   |                     |
 |    - OAuth link          |                         |                     |
 |    - Code input field    |                         |                     |
 |                          |                         |                     |
 |-- click OAuth link -------------------------------------------------->|
 |<-- authorization code -------------------------------------------------|
 |                          |                         |                     |
 |-- POST /login ---------->|                         |                     |
 |   {code: "..."}          |-- write code → stdin -->|                     |
 |                          |<-- login complete ------|                     |
 |<-- redirect / -----------|                         |                     |
```

### Setup Token Flow (Alternative, behind nginx)

```
User                    su-47 Server              Claude CLI
 |                          |                         |
 |-- GET /setup-token ---->|                         |
 |<-- token input page -----|                         |
 |                          |                         |
 |-- POST /setup-token --->|                         |
 |   {token: "..."}         |-- spawn claude setup-token -->|
 |                          |-- write token → stdin -------->|
 |                          |<-- setup complete --------------|
 |<-- redirect / -----------|                         |
```

## Tech Stack

| Layer           | Choice                                    |
|-----------------|-------------------------------------------|
| Language        | TypeScript                                |
| Runtime         | Bun.js (native TS, no build step)         |
| HTTP Server     | `Bun.serve()` (built-in)                  |
| Build           | None — Bun runs TS directly               |
| Dev             | `bun --watch src/index.ts`                |
| Package Manager | Bun (bun install, bun.lockb)              |
| Linter/Format   | Biome                                     |
| Git Hooks       | Husky + lint-staged                       |
| Container       | Docker + docker-compose                   |
| CLI Dependency  | Claude Code CLI (`claude`)                |

## Project Structure

```
su-47/
├── plans/
│   ├── architecture.md         # This file
│   └── tasks.md                # Implementation task breakdown
├── src/
│   ├── index.ts                # HTTP server entrypoint (Bun.serve), routing
│   ├── config.ts               # Environment variables + sukhoi.config.json loader
│   ├── types.ts                # All TypeScript interfaces
│   ├── webhook.ts              # Webhook HMAC validation + event filtering
│   ├── queue.ts                # In-memory concurrent job queue
│   ├── worker.ts               # Job processor (spawns runner.ts)
│   ├── cancel.ts               # Cancel logic (SIGTERM → wait → SIGKILL)
│   ├── router.ts               # Config-driven model routing engine
│   ├── classifier.ts           # LLM-based task complexity classifier
│   ├── plane.ts                # Plane API client
│   ├── prompt.ts               # Prompt builder functions
│   ├── auth.ts                 # Claude CLI OAuth interaction (web UI only)
│   ├── pages.ts                # HTML page generators (for OAuth web UI)
│   └── runner.ts               # Runner: clone, agent, commit, PR (subprocess)
├── biome.json                  # Biome linter + formatter config
├── Dockerfile                  # Single-stage Bun runtime
├── docker-compose.yml          # Service definition with volumes
├── .env.example                # Environment variable template
├── .husky/
│   └── pre-commit              # Husky hook: lint-staged + tsc
├── package.json                # Project config, scripts, lint-staged config
├── tsconfig.json               # TypeScript config (typecheck only, not build)
├── .gitignore
└── LICENSE                     # Apache 2.0
```

## HTTP Routes

### Web UI Routes (behind nginx, protected)

| Method | Path           | Purpose                                              |
|--------|----------------|------------------------------------------------------|
| `GET`  | `/`            | Session info if logged in, redirect to /login if not |
| `GET`  | `/login`       | Start OAuth flow, show OAuth URL + code input        |
| `POST` | `/login`       | Submit authorization code to claude CLI              |
| `GET`  | `/setup-token` | Show long-lived token input page (alternative)       |
| `POST` | `/setup-token` | Submit long-lived token to claude CLI                |
| `POST` | `/logout`      | Run `claude auth logout`, redirect to /              |

### API Routes

| Method | Path       | Protected | Purpose                                     |
|--------|------------|-----------|---------------------------------------------|
| `POST` | `/webhook` | No (HMAC) | Plane webhook receiver (issues + comments)  |
| `GET`  | `/health`  | No        | Health check (queue status)                 |

## Configuration

### Environment Variables (`.env`)

| Variable              | Required | Default | Description                            |
|-----------------------|----------|---------|----------------------------------------|
| `PORT`                | No       | `3000`  | HTTP server port                       |
| `PLANE_API_KEY`       | Yes      | -       | Plane API authentication               |
| `PLANE_BASE_URL`      | Yes      | -       | Plane instance URL                     |
| `PLANE_WORKSPACE_SLUG`| Yes      | -       | Plane workspace slug                   |
| `PLANE_PROJECT_ID`    | Yes      | -       | Plane project UUID                     |
| `WEBHOOK_SECRET`      | Yes      | -       | HMAC secret from Plane webhook settings|
| `GITHUB_TOKEN`        | Yes      | -       | GitHub PAT (repo + workflow scopes)    |
| `CONCURRENCY`         | No       | `1`     | Max parallel jobs                      |
| `JOB_TIMEOUT_MS`      | No       | `1800000`| Runner timeout (30 min)               |
| `REPO_CACHE_DIR`      | No       | `/repo-cache` | Git repo cache path              |
| `LOGIN_TIMEOUT_MS`    | No       | `300000`| OAuth login subprocess timeout (5 min) |

### Application Config (`su-47.config.json`)

Same structure as sukhoi's `sukhoi.config.json`. Hot-reloaded via file watch.

| Field          | Purpose                                                    |
|----------------|------------------------------------------------------------|
| `repo`         | Git clone URL of target repository                         |
| `baseBranch`   | Branch for feature branches (default: `main`)              |
| `prompt`       | System prompt for the AI agent                             |
| `classifier`   | LLM complexity classifier settings                         |
| `models`       | Map of alias → `provider/model` string                     |
| `routing`      | Ordered routing rules (priority/labels/complexity → model) |
| `defaultModel` | Fallback model when no rule matches                        |
| `states`       | Plane state name mapping                                   |
| `worklog`      | Persistent work log settings                               |

### Docker Volumes

| Volume        | Mount Point       | Purpose                              |
|---------------|-------------------|--------------------------------------|
| `claude-home` | `/root/.claude`   | Persist Claude CLI credentials       |
| `repo-cache`  | `/repo-cache`     | Persistent git repo cache            |

## Technical Considerations

### 1. Runtime: Bun.js

- `Bun.serve()` replaces `node:http` — built-in Request/Response API
- `Bun.spawn()` replaces `child_process.spawn` — cleaner Promise-based API
- No build step: `bun run src/index.ts` for both dev and prod
- `bun --watch src/index.ts` for development hot reload
- `bun install` instead of `pnpm install` (generates `bun.lockb`)
- TypeScript is natively supported — no `tsc` emit needed
- `tsconfig.json` kept only for `tsc --noEmit` type checking in pre-commit

### 2. Runner as TypeScript Subprocess

`src/runner.ts` is spawned as a separate Bun subprocess (not `import`ed):
```typescript
const proc = Bun.spawn(["bun", "run", "src/runner.ts"], {
  env: { ...process.env, ...jobEnv },
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
});
```

Benefits over Bash:
- Type safety across server ↔ runner (shared `types.ts`)
- Structured error handling vs. Bash `set -e`
- Bun subprocess API: `proc.stdout`, `proc.kill("SIGTERM")`, `await proc.exited`
- Can use `result.json` for structured output back to server (same as sukhoi)

### 3. Cancel Flow: SIGTERM → SIGKILL

```typescript
// In cancel.ts
async function cancelJob(job: Job): Promise<void> {
  job.process.kill("SIGTERM");

  const timeout = setTimeout(() => {
    job.process.kill("SIGKILL");
  }, 10_000);

  await job.process.exited;
  clearTimeout(timeout);
}
```

The job queue stores the active `Bun.SubProcess` reference alongside the job metadata.

### 4. Parsing OAuth URL from Claude CLI

`claude auth login` is a TUI app. Strategy for extracting OAuth URL:
1. Spawn with `TERM=dumb` — disables TUI rendering, gets plain text
2. Many TUI apps fall back to plain text when stdout is not a TTY (Bun pipes are not TTYs)
3. Strip remaining ANSI codes with regex: `/\x1B\[[0-9;]*[a-zA-Z]/g`
4. Extract URL with regex: `/https:\/\/(claude\.ai|platform\.claude\.com)\/oauth\/authorize\?[^\s"']+/`

### 5. Webhook: Comment Events for Cancel

Plane sends comment webhook events with `event === "comment"` and `action === "created"`.
The comment body is checked for `/cancel` (literal string, starts-with check after trimming).

The issue ID in the comment event is used to find the active job in the queue.

### 6. Biome Configuration

```json
{
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "off"
      },
      "style": {
        "noNonNullAssertion": "off"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "lineWidth": 100,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "javascript": {
    "formatter": {
      "trailingCommas": "all"
    }
  }
}
```

### 7. Pre-commit Hook

`.husky/pre-commit`:
```sh
#!/bin/sh
pnpm lint-staged
pnpm typecheck
```

`package.json` lint-staged config:
```json
{
  "lint-staged": {
    "*.ts": ["biome check --write --no-errors-on-unmatched"]
  }
}
```

`tsc --noEmit` runs on the full project (cannot be scoped to staged files due to
TypeScript requiring full project context for type inference). For a small project
like su-47 (~10 files), this is fast.
