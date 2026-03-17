/**
 * webhook.ts — Plane webhook handler with HMAC-SHA256 signature verification.
 *
 * Validates webhook signature, then routes events:
 * - issue updated + state = "Todo" → enqueue job
 * - comment created + body starts with "/cancel" → cancel job
 */

import type { Env } from "./config";
import type { JobQueue } from "./queue";
import type { PlaneWebhookPayload } from "./types";

// ---------------------------------------------------------------------------
// HMAC Validation
// ---------------------------------------------------------------------------

/**
 * Verify HMAC-SHA256 signature from Plane webhook.
 * Signature format: "sha256=<hex>"
 */
async function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") return false;

  const expectedHex = parts[1];

  // Compute HMAC-SHA256
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature_raw = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computedHex = Array.from(new Uint8Array(signature_raw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison
  if (computedHex.length !== expectedHex.length) return false;

  let mismatch = 0;
  for (let i = 0; i < computedHex.length; i++) {
    if (computedHex.charCodeAt(i) !== expectedHex.charCodeAt(i)) {
      mismatch = 1;
    }
  }

  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Webhook Handler
// ---------------------------------------------------------------------------

export interface WebhookHandlerContext {
  env: Env;
  queue: JobQueue;
  todoStateId: string;
  onCancel: (issueId: string, projectId: string) => Promise<void>;
}

export class WebhookHandler {
  private readonly ctx: WebhookHandlerContext;

  constructor(ctx: WebhookHandlerContext) {
    this.ctx = ctx;
  }

  /**
   * Handle incoming webhook request.
   * Returns Response for HTTP server.
   */
  async handle(req: Request): Promise<Response> {
    // Read raw body (needed for signature verification)
    const rawBody = await req.text();

    // Verify signature
    const signature = req.headers.get("X-Plane-Signature");
    const valid = await verifySignature(rawBody, signature, this.ctx.env.WEBHOOK_SECRET);

    if (!valid) {
      console.warn("[webhook] Invalid signature");
      return new Response("Invalid signature", { status: 401 });
    }

    // Parse payload
    let payload: PlaneWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      console.error("[webhook] Failed to parse JSON:", err);
      return new Response("Invalid JSON", { status: 400 });
    }

    // Respond immediately (process async)
    this.processEvent(payload).catch((err) => {
      console.error("[webhook] Failed to process event:", err);
    });

    return new Response("OK", { status: 200 });
  }

  /**
   * Process webhook event (async, after responding 200 OK).
   */
  private async processEvent(payload: PlaneWebhookPayload): Promise<void> {
    const { event, action } = payload;

    // Issue updated → check if state is "Todo"
    if (event === "issue" && action === "updated") {
      await this.handleIssueUpdated(payload);
      return;
    }

    // Comment created → check for /cancel command
    if (event === "comment" && action === "created") {
      await this.handleCommentCreated(payload);
      return;
    }

    // Ignore other events
    console.log(`[webhook] Ignoring event: ${event}.${action}`);
  }

  /**
   * Handle issue updated event.
   */
  private async handleIssueUpdated(payload: PlaneWebhookPayload): Promise<void> {
    const issue = payload.issue;
    if (!issue) {
      console.warn("[webhook] issue.updated event missing issue data");
      return;
    }

    // Check if state matches "Todo"
    if (issue.state !== this.ctx.todoStateId) {
      console.log(`[webhook] Issue ${issue.id} state is not Todo (${issue.state}), ignoring`);
      return;
    }

    // Check if issue is already queued
    if (this.ctx.queue.hasIssue(issue.id)) {
      console.log(`[webhook] Issue ${issue.id} already queued, ignoring`);
      return;
    }

    // Enqueue job
    const jobId = this.ctx.queue.enqueue(issue.id, issue.project);
    console.log(`[webhook] Enqueued job ${jobId} for issue ${issue.id}`);
  }

  /**
   * Handle comment created event.
   */
  private async handleCommentCreated(payload: PlaneWebhookPayload): Promise<void> {
    const comment = payload.comment;
    if (!comment) {
      console.warn("[webhook] comment.created event missing comment data");
      return;
    }

    const body = comment.body?.trim() ?? "";
    if (!body.startsWith("/cancel")) {
      return;
    }

    console.log(`[webhook] Cancel command detected for issue ${comment.issue}`);

    // Call cancel handler
    await this.ctx.onCancel(comment.issue, comment.project);
  }
}
