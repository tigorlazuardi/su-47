import { useState } from "react";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useNavigate } from "react-router-dom";

interface SetupTokenPageProps {
  onSuccess: () => void;
}

export function SetupTokenPage({ onSuccess }: SetupTokenPageProps) {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await api.auth.setupToken(token.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set up token");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Long-lived Token</CardTitle>
          <CardDescription>
            Use a Claude API token instead of OAuth. Suitable for server environments.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="token">API Token</Label>
              <textarea
                id="token"
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="sk-ant-..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <Button type="submit" className="w-full" disabled={!token.trim() || isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSubmitting ? "Setting up..." : "Save Token"}
            </Button>
          </form>

          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to OAuth login
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
