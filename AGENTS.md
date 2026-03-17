# su-47 — Agent Reference

su-47 is a full rewrite of [sukhoi](https://github.com/tigorlazuardi/sukhoi): an autonomous coding
agent that bridges Plane (project management) with Claude Code CLI. When a Plane issue moves to
"Todo", su-47 picks a model based on issue labels, spawns a runner that implements the task, opens
a GitHub PR, and updates the issue. A Plane comment `/cancel` kills the active runner subprocess.

For full architecture and flow diagrams see `plans/architecture.md`.
For the implementation task checklist see `plans/tasks.md`.

---

## Tech Stack

| Layer           | Choice                                          |
|-----------------|-------------------------------------------------|
| Language        | TypeScript (no build step)                      |
| Runtime         | Bun.js — runs TS directly                       |
| HTTP Server     | `Bun.serve()` built-in                          |
| Dev             | `bun --watch src/index.ts`                      |
| Package Manager | Bun (`bun install`, `bun.lockb`)                |
| Linter/Format   | Biome (`biome.json`)                            |
| Git Hooks       | Husky + lint-staged                             |
| Container       | Docker + docker-compose                         |
| External CLI    | `claude` (Claude Code CLI)                      |

---

## Project Structure

```
su-47/
├── plans/
│   ├── architecture.md   # Full architecture + flow diagrams
│   └── tasks.md          # Phase-by-phase implementation checklist
├── src/
│   ├── index.ts          # Bun.serve() entrypoint — API routes + static SPA
│   ├── config.ts         # Env vars + su-47.config.json loader (hot-reload)
│   ├── types.ts          # All TypeScript interfaces + label-based model selection
│   ├── webhook.ts        # HMAC validation + issue/comment event routing
│   ├── queue.ts          # In-memory concurrent job queue
│   ├── worker.ts         # Job processor (spawns runner.ts)
│   ├── cancel.ts         # SIGTERM → 10s → SIGKILL + Plane state update
│   ├── plane.ts          # Plane REST API client (retry, cache, marked for HTML)
│   ├── prompt.ts         # Prompt + Plane comment builders
│   ├── auth.ts           # Claude CLI OAuth integration (spawn, parse URL, pipe code)
│   └── runner.ts         # Subprocess: git, claude agent, commit, PR, result.json
├── ui/                   # React SPA (Vite + shadcn/ui + Tailwind)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx       # Root + routing (react-router-dom)
│   │   ├── lib/
│   │   │   ├── api.ts    # fetch wrappers for /api/* endpoints
│   │   │   └── utils.ts  # cn() shadcn utility
│   │   ├── components/ui/  # shadcn generated components
│   │   ├── pages/
│   │   │   ├── StatusPage.tsx      # Auth status + logout
│   │   │   ├── LoginPage.tsx       # OAuth URL + code input
│   │   │   └── SetupTokenPage.tsx  # Long-lived token input
│   │   └── hooks/
│   │       └── useAuthStatus.ts    # Poll /api/auth/status every 5s
│   ├── index.html
│   ├── vite.config.ts    # proxy /api/* → :3000 in dev
│   ├── tailwind.config.ts
│   └── package.json
└── ui/dist/              # Built SPA (served statically by Bun.serve())
├── biome.json
├── Dockerfile            # oven/bun:1-slim + gh + claude CLI
├── docker-compose.yml
├── su-47.config.json     # App config (hot-reloaded, not in git)
├── .env                  # Secrets (not in git)
├── .env.example
├── package.json
├── tsconfig.json         # noEmit — typecheck only, Bun handles execution
└── AGENTS.md             # This file (symlinked as CLAUDE.md)
```

---

## HTTP Routes

| Method | Path                | Auth  | Purpose                                        |
|--------|---------------------|-------|------------------------------------------------|
| GET    | `/api/auth/status`  | nginx | `AuthStatus` JSON                              |
| POST   | `/api/auth/login`   | nginx | Spawn `claude auth login` → `{ oauthUrl }`     |
| POST   | `/api/auth/code`    | nginx | Submit OAuth code → `{ ok: true }`             |
| POST   | `/api/auth/token`   | nginx | Submit long-lived token → `{ ok: true }`       |
| POST   | `/api/auth/logout`  | nginx | Run `claude auth logout` → `{ ok: true }`      |
| POST   | `/webhook`          | HMAC  | Plane webhook (issue updated + comment created)|
| GET    | `/health`           | none  | `{ status: "ok", queue: { active, pending } }` |
| GET    | `/*`                | nginx | Serve `ui/dist/` SPA (fallback to index.html)  |

---

## Environment Variables

| Variable               | Required | Default      | Description                        |
|------------------------|----------|--------------|------------------------------------|
| `PORT`                 | No       | `3000`       | HTTP port                          |
| `PLANE_API_KEY`        | Yes      | —            | Plane API key                      |
| `PLANE_BASE_URL`       | Yes      | —            | Plane instance URL                 |
| `PLANE_WORKSPACE_SLUG` | Yes      | —            | Plane workspace slug               |
| `PLANE_PROJECT_ID`     | Yes      | —            | Plane project UUID                 |
| `WEBHOOK_SECRET`       | Yes      | —            | HMAC secret from Plane webhook     |
| `GITHUB_TOKEN`         | Yes      | —            | GitHub PAT (repo + workflow)       |
| `CONCURRENCY`          | No       | `1`          | Max parallel jobs                  |
| `JOB_TIMEOUT_MS`       | No       | `1800000`    | Runner timeout (30 min)            |
| `REPO_CACHE_DIR`       | No       | `/repo-cache`| Git repo cache path                |
| `LOGIN_TIMEOUT_MS`     | No       | `300000`     | OAuth login subprocess timeout     |

---

## su-47.config.json Schema

Hot-reloaded at runtime via file watch. Never commit this file (contains repo URL + prompts).

```jsonc
{
  "repo": "https://github.com/org/repo.git",  // Git clone URL
  "baseBranch": "main",
  "prompt": "You are an expert software engineer...",
  "states": {
    "todo":       "Todo",
    "inProgress": "In Progress",
    "done":       "Review/Testing",
    "failed":     "Cancelled"
  },
  "worklog": { "enabled": true, "maxEntries": 10 }
}
```

---

## Model Selection (Label-Based)

Model is determined by issue labels containing `opus`, `sonnet`, or `haiku` (case insensitive).
The full label name is passed to `claude --model <label>`.

**Examples:**
- Label `sonnet` → `claude --model sonnet` (uses latest sonnet)
- Label `sonnet-4-5` → `claude --model sonnet-4-5` (specific version)
- Label `opus` → `claude --model opus`
- Label `haiku` → `claude --model haiku`
- No matching label → defaults to `sonnet`

```typescript
// Usage in worker.ts
import { resolveModelFromLabels } from "./types";

const model = resolveModelFromLabels(issue.label_details ?? []);
// model: string (e.g., "sonnet", "sonnet-4-5", "opus")
```

This design allows version overrides via label names (e.g., `sonnet-4-5`) while defaulting to the latest version when using base labels (e.g., `sonnet`).

---

## Code Quality Rules

**Biome** is the single source of truth for linting, formatting, and style. Config in `biome.json`.

| Rule                   | Setting     | Reason                              |
|------------------------|-------------|-------------------------------------|
| `noExplicitAny`        | off         | `any` allowed in type parameters    |
| `noNonNullAssertion`   | off         | `!` allowed                         |
| Line width             | 100         |                                     |
| Indent                 | 2 spaces    |                                     |
| Trailing commas        | all         |                                     |
| All other rules        | recommended |                                     |

**Pre-commit hook** (Husky):
1. `bun lint-staged` — runs `biome check --write` on staged `*.ts` files only
2. `bun typecheck` — runs `tsc --noEmit` on full project (cannot be scoped to staged files)

**Scripts:**
```sh
bun run dev        # bun --watch src/index.ts
bun run start      # bun run src/index.ts
bun run typecheck  # tsc --noEmit
bun run check      # biome check src/
bun run format     # biome format --write src/
bun run lint       # biome lint src/
```

---

## Key Implementation Patterns

### Spawning the runner
```typescript
const proc = Bun.spawn(["bun", "run", "src/runner.ts"], {
  env: { ...process.env, ISSUE_ID: job.issueId, MODEL: model, PROMPT: prompt },
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
  cwd: "/app",
});
```

### Cancel: SIGTERM → 10s → SIGKILL
```typescript
proc.kill("SIGTERM");
const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
await proc.exited;
clearTimeout(killTimer);
```

### OAuth URL extraction from `claude auth login` stdout
```typescript
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
const OAUTH_RE = /https:\/\/(claude\.ai|platform\.claude\.com)\/oauth\/authorize\?[^\s"']+/;
// spawn with TERM=dumb, read stdout chunks, strip ANSI, match URL
```

### Bun.serve() routing pattern
```typescript
Bun.serve({
  port: env.PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const method = req.method;
    if (method === "GET"  && pathname === "/")        return handleRoot();
    if (method === "GET"  && pathname === "/login")   return handleGetLogin();
    if (method === "POST" && pathname === "/login")   return handlePostLogin(req);
    if (method === "POST" && pathname === "/webhook") return handleWebhook(req);
    if (method === "GET"  && pathname === "/health")  return handleHealth();
    return new Response("Not Found", { status: 404 });
  },
});
```

### Webhook: cancel detection
```typescript
if (payload.event === "comment" && payload.action === "created") {
  if (payload.comment?.body?.trim().startsWith("/cancel")) {
    await handleCancel(payload.issue.id);
  }
}
```

---

## Docker Volumes

| Volume        | Mount Point     | Purpose                         |
|---------------|-----------------|---------------------------------|
| `claude-home` | `/root/.claude` | Persist Claude CLI credentials  |
| `repo-cache`  | `/repo-cache`   | Persistent git repo cache       |

---

## Task Tracking

After completing any implementation task, update `plans/tasks.md` to reflect the current state:
- Mark completed items with `[x]`
- Keep the checklist accurate so it remains a reliable source of truth for project progress
