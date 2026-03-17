/**
 * plane.ts — Plane REST API client with retry and in-memory cache.
 */

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
  // Plane uses TipTap/ProseMirror for rich text editing
  let html = markdown;

  // Process code blocks first (``` ... ```)
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    // Escape HTML in code block
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Escape HTML special chars in non-code sections
  // Split by <pre> tags to avoid escaping code blocks
  const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/);
  html = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // Keep code blocks as-is
      return part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("");

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_ (but not in URLs or already processed)
  html = html.replace(/(?<!\*)\*([^*\s][^*]*?)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!_)_([^_\s][^_]*?)_(?!_)/g, "<em>$1</em>");

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Links: [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // Headers (must be at start of line)
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Paragraphs: split by double newlines
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";

      // Don't wrap if already has block tags
      if (
        /^<(h[1-6]|pre|ul|ol|blockquote|div)/.test(trimmed) ||
        /^<\/(h[1-6]|pre|ul|ol|blockquote|div)/.test(trimmed)
      ) {
        return trimmed;
      }

      // Process lists within paragraph
      const lines = trimmed.split("\n");
      const processed: string[] = [];
      let listItems: string[] = [];

      for (const line of lines) {
        if (/^[*-] /.test(line)) {
          // This is a list item
          listItems.push(`<li>${line.replace(/^[*-] /, "")}</li>`);
        } else {
          // Not a list item - flush any pending list items
          if (listItems.length > 0) {
            processed.push(`<ul>${listItems.join("")}</ul>`);
            listItems = [];
          }
          processed.push(line);
        }
      }

      // Flush any remaining list items
      if (listItems.length > 0) {
        processed.push(`<ul>${listItems.join("")}</ul>`);
      }

      // Join non-list content and wrap in <p>
      const result = processed.join("\n");

      // If result contains block tags, return as-is
      if (/<(ul|pre|h[1-6])/.test(result)) {
        return result;
      }

      // Otherwise wrap in paragraph
      return `<p>${result.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html;
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
