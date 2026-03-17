/**
 * auth.ts — Claude CLI OAuth integration.
 *
 * Manages spawning `claude auth login`, extracting the OAuth URL from stdout,
 * piping the auth code back, and handling long-lived token setup.
 */

import type { Env } from "./config";
import type { AuthStatus, LoginSession } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
const OAUTH_RE = /https:\/\/(claude\.ai|platform\.claude\.com)\/oauth\/authorize\?[^\s"']+/;

// ---------------------------------------------------------------------------
// Module-level state (only one login session at a time)
// ---------------------------------------------------------------------------

let activeLoginSession: LoginSession | null = null;

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

/**
 * Run `claude auth status --json` and parse the output.
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  const proc = Bun.spawn(["claude", "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, TERM: "dumb" },
  });

  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  try {
    const parsed = JSON.parse(stdout.trim());
    return {
      loggedIn: parsed.loggedIn ?? parsed.logged_in ?? false,
      authMethod: parsed.authMethod ?? parsed.auth_method,
      email: parsed.email,
      orgId: parsed.orgId ?? parsed.org_id,
      orgName: parsed.orgName ?? parsed.org_name,
      subscriptionType: parsed.subscriptionType ?? parsed.subscription_type,
    };
  } catch {
    return { loggedIn: false };
  }
}

// ---------------------------------------------------------------------------
// OAuth login
// ---------------------------------------------------------------------------

/**
 * Spawn `claude auth login`, buffer stdout until the OAuth URL appears,
 * and return a LoginSession. The subprocess stays alive waiting for the
 * auth code.
 *
 * Kills any existing session before starting a new one.
 */
export async function startLogin(env: Env): Promise<LoginSession> {
  // Clean up any existing session
  killLoginSession();

  const proc = Bun.spawn(["claude", "auth", "login"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });

  // Read stdout until OAuth URL appears
  const oauthUrl = await extractOAuthUrl(proc, env.LOGIN_TIMEOUT_MS);

  const timeoutId = setTimeout(() => {
    console.warn("[auth] Login session timed out, killing subprocess");
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already exited
    }
    activeLoginSession = null;
  }, env.LOGIN_TIMEOUT_MS);

  const session: LoginSession = {
    process: proc,
    oauthUrl,
    createdAt: Date.now(),
    timeoutId,
  };

  activeLoginSession = session;
  return session;
}

/**
 * Read stdout from the login subprocess until the OAuth URL is found.
 */
async function extractOAuthUrl(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        reject(new Error("Timed out waiting for OAuth URL from claude auth login"));
      },
      Math.min(timeoutMs, 30_000),
    );

    let buffer = "";

    async function readChunks() {
      try {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          const text = new TextDecoder().decode(chunk).replace(ANSI_RE, "");
          buffer += text;

          const match = buffer.match(OAUTH_RE);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
            return;
          }
        }
        clearTimeout(timer);
        reject(new Error("claude auth login exited without producing OAuth URL"));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }

    readChunks();
  });
}

// ---------------------------------------------------------------------------
// Submit auth code
// ---------------------------------------------------------------------------

/**
 * Write the auth code to the active login subprocess stdin and wait for exit.
 */
export async function submitAuthCode(code: string): Promise<void> {
  if (!activeLoginSession) {
    throw new Error("No active login session. Call startLogin() first.");
  }

  const session = activeLoginSession;

  // Write code + newline to stdin then close
  const stdin = session.process.stdin as import("bun").FileSink;
  stdin.write(`${code}\n`);
  stdin.end();

  const exitCode = await session.process.exited;

  clearTimeout(session.timeoutId);
  activeLoginSession = null;

  if (exitCode !== 0) {
    throw new Error(`claude auth login exited with code ${exitCode}`);
  }
}

// ---------------------------------------------------------------------------
// Long-lived token
// ---------------------------------------------------------------------------

/**
 * Submit a long-lived token via `claude setup-token`.
 */
export async function setupToken(token: string): Promise<void> {
  const proc = Bun.spawn(["claude", "setup-token"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });

  const stdin = proc.stdin as import("bun").FileSink;
  stdin.write(`${token}\n`);
  stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude setup-token failed: ${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Run `claude auth logout` and wait for completion.
 */
export async function logout(): Promise<void> {
  killLoginSession();

  const proc = Bun.spawn(["claude", "auth", "logout"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, TERM: "dumb" },
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude auth logout failed: ${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the current active login session's OAuth URL, if one exists.
 */
export function getActiveOAuthUrl(): string | null {
  return activeLoginSession?.oauthUrl ?? null;
}

/**
 * Kill the active login session — call on server shutdown.
 */
export function killLoginSession(): void {
  if (!activeLoginSession) return;
  clearTimeout(activeLoginSession.timeoutId);
  try {
    activeLoginSession.process.kill("SIGTERM");
  } catch {
    // Already exited
  }
  activeLoginSession = null;
}
