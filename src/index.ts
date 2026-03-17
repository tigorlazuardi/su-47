/**
 * index.ts — Bun.serve() entrypoint.
 *
 * Routes:
 *  GET  /api/auth/status  → auth status JSON
 *  POST /api/auth/login   → start OAuth login → { oauthUrl }
 *  POST /api/auth/code    → submit OAuth code → { ok }
 *  POST /api/auth/token   → setup long-lived token → { ok }
 *  POST /api/auth/logout  → logout → { ok }
 *  POST /webhook          → Plane webhook (HMAC verified)
 *  GET  /health           → { status, queue }
 *  GET  /*                → serve ui/dist/ SPA (fallback to index.html)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAuthStatus,
  killLoginSession,
  logout,
  setupToken,
  startLogin,
  submitAuthCode,
} from "./auth";
import { cancelJob } from "./cancel";
import { env, loadConfig, watchConfig } from "./config";
import { PlaneClient } from "./plane";
import { JobQueue } from "./queue";
import type { SukhoiConfig } from "./types";
import { WebhookHandler } from "./webhook";
import { processJob } from "./worker";

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log("[su-47] Starting...");

let config: SukhoiConfig = loadConfig();
const plane = new PlaneClient(env);
const queue = new JobQueue(env.CONCURRENCY);

// Resolve Plane state UUIDs at startup
const todoStateId = await plane.getStateId(env.PLANE_PROJECT_ID, config.states.todo);
const inProgressStateId = await plane.getStateId(env.PLANE_PROJECT_ID, config.states.inProgress);
const doneStateId = await plane.getStateId(env.PLANE_PROJECT_ID, config.states.done);
const failedStateId = await plane.getStateId(env.PLANE_PROJECT_ID, config.states.failed);

console.log(`[su-47] State IDs resolved — todo: ${todoStateId}`);

// Wire up job processor
queue.setProcessor((job) =>
  processJob(job, {
    env,
    config,
    plane,
    queue,
    inProgressStateId,
    doneStateId,
    failedStateId,
  }),
);

// Wire up webhook handler
const webhookHandler = new WebhookHandler({
  env,
  queue,
  todoStateId,
  onCancel: async (issueId, projectId) => {
    await cancelJob(issueId, projectId, { queue, plane, config, failedStateId });
  },
});

// Hot-reload config
const configWatcher = watchConfig((updated) => {
  config = updated;
  console.log("[su-47] Config reloaded");
});

// ---------------------------------------------------------------------------
// Static SPA serving
// ---------------------------------------------------------------------------

const UI_DIST = join(import.meta.dir, "..", "ui", "dist");
const INDEX_HTML = join(UI_DIST, "index.html");

function serveStatic(pathname: string): Response {
  if (!existsSync(UI_DIST)) {
    return new Response("UI not built. Run: cd ui && bun run build", { status: 503 });
  }

  // Try exact file first
  const filePath = join(UI_DIST, pathname === "/" ? "index.html" : pathname);
  const file = Bun.file(filePath);

  // Bun.file() doesn't throw for missing files — check size or use existsSync
  if (existsSync(filePath)) {
    return new Response(file);
  }

  // SPA fallback → index.html
  return new Response(Bun.file(INDEX_HTML));
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Auth API handlers
// ---------------------------------------------------------------------------

async function handleAuthApi(req: Request, pathname: string, method: string): Promise<Response> {
  if (method === "GET" && pathname === "/api/auth/status") {
    return json(await getAuthStatus());
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const session = await startLogin(env);
    return json({ oauthUrl: session.oauthUrl });
  }

  if (method === "POST" && pathname === "/api/auth/code") {
    const body = (await req.json().catch(() => ({}))) as { code?: string };
    if (!body.code) return jsonError("Missing field: code");
    await submitAuthCode(body.code);
    return json({ ok: true });
  }

  if (method === "POST" && pathname === "/api/auth/token") {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    if (!body.token) return jsonError("Missing field: token");
    await setupToken(body.token);
    return json({ ok: true });
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    await logout();
    return json({ ok: true });
  }

  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: env.PORT,

  async fetch(req) {
    const { pathname } = new URL(req.url);
    const method = req.method;

    try {
      if (method === "GET" && pathname === "/health") {
        return json({ status: "ok", queue: queue.status() });
      }

      if (method === "POST" && pathname === "/webhook") {
        return webhookHandler.handle(req);
      }

      if (pathname.startsWith("/api/auth/")) {
        return handleAuthApi(req, pathname, method);
      }

      if (method === "GET") {
        return serveStatic(pathname);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("[su-47] Unhandled error:", err);
      return jsonError("Internal server error", 500);
    }
  },
});

console.log(`[su-47] Listening on http://localhost:${server.port}`);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  console.log(`[su-47] Received ${signal}, shutting down...`);
  configWatcher.close();
  killLoginSession();
  await queue.killActive();
  server.stop();
  console.log("[su-47] Bye.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
