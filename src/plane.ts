/**
 * plane.ts — Plane REST API client with retry and in-memory cache.
 */

import { marked } from "marked";
import type { Env } from "./config";
import type { PlaneComment, PlaneIssue, PlaneState } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert a markdown string to HTML rich text suitable for Plane comments. */
function markdownToHtml(markdown: string): string {
  return marked(markdown, { async: false }) as string;
}

// ---------------------------------------------------------------------------
// PlaneClient
// ---------------------------------------------------------------------------

export class PlaneClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  /** Cached states: projectId → state list */
  private statesCache = new Map<string, PlaneState[]>();

  constructor(env: Env) {
    // Normalise: strip trailing slash
    const base = env.PLANE_BASE_URL.replace(/\/$/, "");
    this.baseUrl = `${base}/api/v1/workspaces/${env.PLANE_WORKSPACE_SLUG}`;
    this.apiKey = env.PLANE_API_KEY;
  }

  // -------------------------------------------------------------------------
  // Internal fetch with retry + exponential backoff
  // -------------------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt >= 3) {
        throw new Error(`Plane API network error after ${attempt} attempts: ${err}`);
      }
      await sleep(200 * 2 ** (attempt - 1));
      return this.request<T>(method, path, body, attempt + 1);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      if (attempt < 3 && response.status >= 500) {
        await sleep(200 * 2 ** (attempt - 1));
        return this.request<T>(method, path, body, attempt + 1);
      }
      throw new Error(`Plane API ${method} ${path} → ${response.status}: ${text}`);
    }

    // 204 No Content
    if (response.status === 204) return undefined as T;

    return response.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // States
  // -------------------------------------------------------------------------

  /** List all states for a project. Results are cached per project. */
  async getStates(projectId: string): Promise<PlaneState[]> {
    const cached = this.statesCache.get(projectId);
    if (cached) return cached;

    const data = await this.request<{ results: PlaneState[] }>(
      "GET",
      `/projects/${projectId}/states/`,
    );
    const states = data.results ?? [];
    this.statesCache.set(projectId, states);
    return states;
  }

  /** Resolve a state name to its UUID. Throws if not found. */
  async getStateId(projectId: string, name: string): Promise<string> {
    const states = await this.getStates(projectId);
    const match = states.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      throw new Error(
        `Plane state "${name}" not found in project ${projectId}. ` +
          `Available: ${states.map((s) => s.name).join(", ")}`,
      );
    }
    return match.id;
  }

  /** Invalidate the states cache for a project (call after state changes). */
  invalidateStatesCache(projectId: string): void {
    this.statesCache.delete(projectId);
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  /** Fetch a full issue by ID. */
  async getIssue(projectId: string, issueId: string): Promise<PlaneIssue> {
    return this.request<PlaneIssue>("GET", `/projects/${projectId}/issues/${issueId}/`);
  }

  /** Update the state of an issue. */
  async updateIssueState(projectId: string, issueId: string, stateId: string): Promise<void> {
    await this.request<void>("PATCH", `/projects/${projectId}/issues/${issueId}/`, {
      state: stateId,
    });
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  /**
   * Post a comment on an issue. `markdown` is converted to HTML internally.
   */
  async addComment(projectId: string, issueId: string, markdown: string): Promise<PlaneComment> {
    return this.request<PlaneComment>(
      "POST",
      `/projects/${projectId}/issues/${issueId}/comments/`,
      { comment_html: markdownToHtml(markdown) },
    );
  }
}
