import { useState } from "react";
import { ExternalLink, KeyRound, Loader2, LogIn } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useNavigate } from "react-router-dom";

interface LoginPageProps {
  onSuccess: () => void;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<"idle" | "waiting-url" | "waiting-code">("idle");
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartLogin() {
    setStep("waiting-url");
    setError(null);
    try {
      const { oauthUrl } = await api.auth.login();
      setOauthUrl(oauthUrl);
      setStep("waiting-code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start login");
      setStep("idle");
    }
  }

  async function handleSubmitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await api.auth.submitCode(code.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <LogIn className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Sign in to Claude</CardTitle>
          <CardDescription>Authenticate su-47 with your Claude account</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {step === "idle" && (
            <Button className="w-full" onClick={handleStartLogin}>
              <LogIn className="h-4 w-4" />
              Start OAuth Login
            </Button>
          )}

          {step === "waiting-url" && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Waiting for OAuth URL...
            </div>
          )}

          {step === "waiting-code" && oauthUrl && (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Open the link below to authorize in your browser, then paste the code here.
                </p>
                <Button variant="outline" className="w-full" asChild>
                  <a href={oauthUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    Open Authorization Page
                  </a>
                </Button>
              </div>

              <form onSubmit={handleSubmitCode} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="code">Authorization Code</Label>
                  <Input
                    id="code"
                    placeholder="Paste code here..."
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoFocus
                    autoComplete="off"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={!code.trim() || isSubmitting}>
                  {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isSubmitting ? "Verifying..." : "Submit Code"}
                </Button>
              </form>
            </div>
          )}

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={() => navigate("/setup-token")}
          >
            <KeyRound className="h-4 w-4" />
            Use a long-lived token instead
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
