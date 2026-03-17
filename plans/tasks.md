# su-47 Implementation Tasks

## Phase 1: Project Setup

- [x] Initialize git repository (`git init`)
- [x] Create `package.json` for Bun project
  - `name: "su-47"`
  - Scripts: `dev`, `start`, `typecheck`, `check`, `format`, `lint`
  - `lint-staged` config: `"*.ts": ["biome check --write --no-errors-on-unmatched"]`
- [x] Create `tsconfig.json` (for `tsc --noEmit` typecheck only, no emit)
  - `"target": "ESNext"`, `"module": "Bundler"`, `"moduleResolution": "bundler"`
  - `"strict": true`, `"noEmit": true`
- [x] Install dev dependencies via `bun add -d`:
  - `typescript`
  - `@biomejs/biome`
  - `husky`
  - `lint-staged`
  - `@types/bun`
- [x] Create `biome.json`:
  - `linter.rules.recommended: true`
  - `linter.rules.suspicious.noExplicitAny: "off"` (allow `any` in type params)
  - `linter.rules.style.noNonNullAssertion: "off"` (allow `!` non-null assertion)
  - `formatter.lineWidth: 100`
  - `formatter.indentStyle: "space"`, `indentWidth: 2`
  - `javascript.formatter.trailingCommas: "all"`
- [x] Setup Husky:
  - `bunx husky init`
  - `.husky/pre-commit`: run `bun lint-staged` then `bun typecheck`
- [x] Create `.gitignore`
  - `node_modules/`, `.env`, `dist/`
- [x] Create `LICENSE` (Apache 2.0)
- [x] Create `.env.example` with all required env vars

## Phase 2: Core Types & Config

- [x] `src/types.ts` — All TypeScript interfaces (centralized)
  - `AuthStatus` — output of `claude auth status --json`
    - `loggedIn: boolean`, `authMethod`, `email`, `orgId`, `orgName`, `subscriptionType`
  - `LoginSession` — active OAuth login subprocess
    - `process: ReturnType<typeof Bun.spawn>`, `oauthUrl: string`
    - `createdAt: number`, `timeoutId: ReturnType<typeof setTimeout>`
  - `PlaneLabel`, `PlaneIssue`, `PlaneState`, `PlaneComment`, `PlaneWebhookPayload`
  - `SukhoiConfig`, `WorklogConfig`, `StateNames`
  - `Job` — `{ id: string, issueId: string, projectId: string, process: BunSubProcess, signal: AbortController }`
  - `RunnerResult`, `RunnerUsage`
  - `ModelLabel` — `"opus" | "sonnet" | "haiku"` (hardcoded valid labels)
  - `MODEL_IDS` — const mapping label → full model ID
  - `DEFAULT_MODEL` — `"sonnet"` (fallback when no label matches)
  - `resolveModelFromLabels(labels)` — determine model from issue labels
- [x] `src/config.ts` — Config loader
  - Load + validate env vars (throw early with clear error if missing required)
  - Load + validate `su-47.config.json` (simplified schema, no routing/classifier)
  - Required fields: `repo`, `baseBranch`, `prompt`, `states`, `worklog`
  - Export typed `config` and `env` objects
  - `watchConfig(onChange)` — `fs.watch` for hot-reload
  - Env vars: `PORT`, `PLANE_API_KEY`, `PLANE_BASE_URL`, `PLANE_WORKSPACE_SLUG`,
    `PLANE_PROJECT_ID`, `WEBHOOK_SECRET`, `GITHUB_TOKEN`, `CONCURRENCY`,
    `JOB_TIMEOUT_MS`, `REPO_CACHE_DIR`, `LOGIN_TIMEOUT_MS`

## Phase 3: Plane API Client

- [x] `src/plane.ts` — Plane REST API client
  - Base URL: `{PLANE_BASE_URL}/api/v1/workspaces/{PLANE_WORKSPACE_SLUG}`
  - Auth: `X-API-Key` header
  - Retry: 3 attempts with exponential backoff
  - In-memory cache for states and labels
  - `getStates()` — list all states
  - `getStateId(name)` — resolve state name → UUID (cached)
  - `getIssue(projectId, issueId)` — fetch full issue
  - `updateIssueState(projectId, issueId, stateId)` — update issue state
  - `addComment(projectId, issueId, markdown)` — post comment (markdown → HTML via built-in or simple converter)

## Phase 4: Job Queue

- [x] `src/queue.ts` — In-memory concurrent job queue
  - Configurable concurrency (from `CONCURRENCY` env, default 1)
  - UUID-based job IDs (via `crypto.randomUUID()`)
  - Each job has an `AbortController`
  - Store active job `BunSubProcess` reference for cancel
  - `enqueue(issueId, projectId)` — add job, start if slot available, returns job ID
  - `findActiveByIssueId(issueId)` — look up running job by Plane issue ID
  - `findPendingByIssueId(issueId)` — look up pending job by Plane issue ID
  - `hasIssue(issueId)` — check if issue is already queued
  - `setProcess(jobId, proc)` — store subprocess ref after spawn
  - `killActive()` — graceful shutdown (SIGTERM all active, drop pending)
  - `cancelJob(jobId)` — cancel specific job by ID
  - `cancelByIssueId(issueId)` — cancel job by issue ID
  - Auto-drains: starts next job when slot opens
  - `status()` — returns `{ active: number, pending: number }` for health check

## Phase 5: Webhook Handler

- [x] `src/webhook.ts` — Webhook processing
  - HMAC-SHA256 signature verification (`X-Plane-Signature` header)
    - Use timing-safe comparison to prevent timing attacks
    - Raw body for signature computation (read before parsing)
  - Respond `200 OK` immediately, process async
  - Event routing:
    - `event === "issue" && action === "updated"` → check state → enqueue job
    - `event === "comment" && action === "created"` → check body for `/cancel` → cancel flow
  - Issue event: filter by `state.id === todoStateId` (resolved at startup)
  - Comment event: `body.trim().startsWith("/cancel")`
  - Check if issue already queued before enqueuing

## Phase 6: Cancel Logic

- [x] `src/cancel.ts` — Cancel a running job
  - `cancelJob(issueId, projectId, ctx)`:
    1. Find job by issue ID (active or pending)
    2. Cancel via `queue.cancelByIssueId()`
    3. Queue handles SIGTERM → 10s → SIGKILL
  - After cancellation:
    - Update Plane issue state → "Cancelled"
    - Post comment: "Job cancelled by /cancel command"
  - Edge cases:
    - Job not found → post comment: "No active job found for this issue"

## Phase 7: Model Selection (Label-Based)

- [x] Label-based model selection (implemented in `src/types.ts`)
  - No separate router or classifier needed
  - Accepts labels: `opus`, `sonnet`, `haiku` (case insensitive)
  - If no matching label found, defaults to `sonnet`
  - `resolveModelFromLabels(labels)` returns `{ label, modelId }`
  - Model IDs hardcoded:
    - `opus` → `claude-opus-4-5`
    - `sonnet` → `claude-sonnet-4-20250514`
    - `haiku` → `claude-haiku-4-20250514`

## Phase 8: Prompt Builder

- [x] `src/prompt.ts` — Prompt construction
  - `buildPrompt(config, issue)` — combine system prompt + task context
    - Title, description, labels, priority, state
  - `buildModelComment(label, modelId)` — Plane comment for model selection
  - `buildCompletionComment(result)` — Plane comment with PR link, cost, tokens
  - `buildQueuedComment(position)` — initial queued notification
  - `buildCancelledComment()` — cancellation confirmation
  - `buildTimeoutComment(timeoutMs)` — timeout notification

## Phase 9: Runner

- [x] `src/runner.ts` — Coding agent subprocess (run by `bun run src/runner.ts`)
  - Receives all context via environment variables (set by worker)
  - Steps:
    1. **Authenticate GitHub** — `gh auth login --with-token` (pipe GITHUB_TOKEN)
    2. **Configure git identity** — `git config user.name/email`
    3. **Manage repo cache** (`REPO_CACHE_DIR`):
       - Fresh clone if cache empty
       - `git fetch + reset --hard` if cache exists
       - Destroy and re-clone on conflicts
    4. **Create git worktree** — branch name: `fix/{project-slug}-{sequence}`
    5. **Install dependencies** — detect lockfile (bun/pnpm/yarn/npm) and install
    6. **Run claude agent** — `claude -p --model $MODEL --output-format stream-json "$PROMPT"`
    7. **Parse usage** — extract cost/tokens from stream-json output
    8. **Check for changes** — `git status --porcelain`
    9. **Commit changes** — `git add -A && git commit -m "fix: {slug}-{seq}"`
    10. **Push + create PR** — `gh pr create --base $BASE_BRANCH`
    11. **Cleanup worktree** — `git worktree remove --force`
    12. **Write `result.json`** — `{ prUrl, commitUrl, commitSha, usage, skipped }`
  - Handle "no changes" case (`skipped: true`)
  - All errors caught and written to `result.json` error field

## Phase 10: Worker

- [x] `src/worker.ts` — Job processor
  - `processJob(job, ctx)`:
    1. Fetch issue from Plane API
    2. Update state → "In Progress"
    3. Resolve model from labels (`resolveModelFromLabels(issue.label_details)`)
    4. Post model selection comment
    5. Build prompt
    6. Spawn `bun run src/runner.ts` with all env vars
    7. Store subprocess ref in job (for cancel)
    8. Await subprocess with timeout (`JOB_TIMEOUT_MS`)
    9. Read `result.json`
    10. Update state → "Review/Testing" (success) or "Cancelled" (failure/timeout)
    11. Post completion comment
  - Handle timeout: kill subprocess, update state, post timeout comment
  - Handle errors: update state, post error comment
  - Clean up result.json after reading

## Phase 11: Auth Web UI

- [ ] `src/auth.ts` — Claude CLI OAuth integration
  - `getAuthStatus()` — run `claude auth status --json`, parse output
  - `startLogin()` — spawn `claude auth login`
    - Set `TERM=dumb` to disable TUI
    - Buffer stdout, strip ANSI codes
    - Detect OAuth URL via regex
    - Return `LoginSession` with process ref + URL
    - Auto-expire after `LOGIN_TIMEOUT_MS`
  - `submitAuthCode(session, code)` — write code to subprocess stdin, await completion
  - `setupToken(token)` — spawn `claude setup-token`, pipe token to stdin
  - `logout()` — spawn `claude auth logout`, await completion
  - Module-level `activeLoginSession: LoginSession | null` (only one at a time)

- [ ] `src/pages.ts` — HTML page generators (no template engine, inline CSS)
  - `statusPage(authStatus)` — email, org, subscription type + logout button
  - `loginPage(oauthUrl)` — clickable OAuth link (new tab) + auth code input + submit
    - Show link to `/setup-token` as alternative
  - `setupTokenPage()` — token input form + link back to `/login`
  - `errorPage(message, backUrl)` — error with back link
  - All pages: minimal inline CSS, 100% functional without JS (plain HTML forms)

## Phase 12: HTTP Server

- [ ] `src/index.ts` — `Bun.serve()` entrypoint
  - Route dispatch (manual, no framework):
    - Web UI routes (nginx-protected in production, all on same port):
      - `GET /` → auth status → status page or redirect `/login`
      - `GET /login` → `auth.startLogin()` → login page
      - `POST /login` → `auth.submitAuthCode()` → redirect `/`
      - `GET /setup-token` → setup token page
      - `POST /setup-token` → `auth.setupToken()` → redirect `/`
      - `POST /logout` → `auth.logout()` → redirect `/`
    - API routes:
      - `POST /webhook` → `webhook.handle()`
      - `GET /health` → JSON `{ status: "ok", queue: { active, pending } }`
    - `404` for everything else
  - Body parsing for form submissions (`application/x-www-form-urlencoded`)
  - Startup:
    - Validate all required env vars
    - Load config (`su-47.config.json`)
    - Resolve Plane "Todo" state UUID
    - Start config file watcher
    - Create `JobQueue`
  - Graceful shutdown (`SIGTERM`, `SIGINT`):
    - `queue.killActive()`
    - Kill active login subprocess if any

## Phase 13: Docker Setup

- [ ] `Dockerfile` — Single-stage Bun runtime
  - Base: `oven/bun:1-slim`
  - Install: `git`, `curl`, `ca-certificates`, `gh` (GitHub CLI)
  - Install: `claude` (Claude Code CLI via npm: `npm install -g @anthropic-ai/claude-code`)
  - Copy source files (`src/`, `package.json`, `bun.lockb`, `tsconfig.json`)
  - `bun install --frozen-lockfile --production`
  - Expose port 3000
  - `CMD ["bun", "run", "src/index.ts"]`
- [ ] `docker-compose.yml`
  - Service: `su-47`
  - Image: `${SU47_IMAGE:-}` with `build: .` fallback
  - Port: `3000:3000`
  - `env_file: .env`
  - `volumes`:
    - `./su-47.config.json:/app/su-47.config.json:ro` (hot-reloadable)
    - `claude-home:/root/.claude` (credential persistence)
    - `repo-cache:/repo-cache` (git repo cache)
  - Named volumes: `claude-home`, `repo-cache`

## Phase 14: CI/CD (Optional, Later)

- [ ] GitHub Actions `publish.yml`
  - Trigger: push to `main`, version tags, manual dispatch
  - Platforms: `linux/amd64`, `linux/arm64`
  - Push to GHCR
- [ ] GitHub Actions `update-claude.yml`
  - Daily cron: check npm for latest `@anthropic-ai/claude-code` version
  - Rebuild if new version available

---

## Implementation Notes

### Bun.spawn vs child_process

```typescript
// Spawning the runner
const proc = Bun.spawn(["bun", "run", "src/runner.ts"], {
  env: { ...process.env, ISSUE_ID: job.issueId, MODEL: model, PROMPT: prompt },
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
  cwd: "/app",
});

// Cancel: SIGTERM → wait 10s → SIGKILL
proc.kill("SIGTERM");
const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
await proc.exited;
clearTimeout(killTimer);
```

### Bun.serve() Routing

```typescript
Bun.serve({
  port: env.PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === "GET" && url.pathname === "/") return handleRoot(req);
    if (method === "GET" && url.pathname === "/login") return handleGetLogin(req);
    if (method === "POST" && url.pathname === "/login") return handlePostLogin(req);
    // ...
    return new Response("Not Found", { status: 404 });
  },
});
```

### OAuth URL Extraction

```typescript
const ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;
const OAUTH_URL_REGEX = /https:\/\/(claude\.ai|platform\.claude\.com)\/oauth\/authorize\?[^\s"']+/;

// Buffer stdout chunks, strip ANSI, scan for URL
for await (const chunk of proc.stdout) {
  const text = new TextDecoder().decode(chunk).replace(ANSI_REGEX, "");
  const match = text.match(OAUTH_URL_REGEX);
  if (match) return match[0];
}
```

### Form Body Parsing (Bun)

```typescript
async function parseFormBody(req: Request): Promise<URLSearchParams> {
  const text = await req.text();
  return new URLSearchParams(text);
}

// Usage in POST /login
const params = await parseFormBody(req);
const code = params.get("code") ?? "";
```

### Cancel Webhook Detection

```typescript
// In webhook.ts event routing
if (payload.event === "comment" && payload.action === "created") {
  const body = payload.comment?.body?.trim() ?? "";
  if (body.startsWith("/cancel")) {
    await handleCancel(payload.issue.id, payload.project);
  }
}
```

### Config File Schema (su-47.config.json)

Simplified config — model selection is now label-based (no routing rules needed).

```json
{
  "repo": "https://github.com/org/repo.git",
  "baseBranch": "main",
  "prompt": "You are an expert software engineer...",
  "states": {
    "todo": "Todo",
    "inProgress": "In Progress",
    "done": "Review/Testing",
    "failed": "Cancelled"
  },
  "worklog": {
    "enabled": true,
    "maxEntries": 10
  }
}
```

### Model Selection

Model is determined by issue labels (case insensitive):
- Label `opus` → `claude-opus-4-5`
- Label `sonnet` → `claude-sonnet-4-20250514`
- Label `haiku` → `claude-haiku-4-20250514`
- No matching label → defaults to `sonnet`
