/**
 * api.ts — Fetch wrappers for /api/auth/* endpoints.
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    status(): Promise<AuthStatus> {
      return request("GET", "/api/auth/status");
    },

    login(): Promise<{ oauthUrl: string }> {
      return request("POST", "/api/auth/login");
    },

    submitCode(code: string): Promise<{ ok: true }> {
      return request("POST", "/api/auth/code", { code });
    },

    setupToken(token: string): Promise<{ ok: true }> {
      return request("POST", "/api/auth/token", { token });
    },

    logout(): Promise<{ ok: true }> {
      return request("POST", "/api/auth/logout");
    },
  },
};
