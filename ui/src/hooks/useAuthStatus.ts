import { useState, useEffect, useCallback } from "react";
import { api, type AuthStatus } from "@/lib/api";

interface UseAuthStatusResult {
  status: AuthStatus | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 5_000;

export function useAuthStatus(): UseAuthStatusResult {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      const result = await api.auth.status();
      setStatus(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch auth status");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetch]);

  return { status, isLoading, error, refetch: fetch };
}
