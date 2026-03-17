import { useState } from "react";
import { LogOut, User, Building2, CreditCard, Shield } from "lucide-react";
import { api, type AuthStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface StatusPageProps {
  status: AuthStatus;
  onLogout: () => void;
}

export function StatusPage({ status, onLogout }: StatusPageProps) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    setIsLoggingOut(true);
    setError(null);
    try {
      await api.auth.logout();
      onLogout();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Logout failed");
      setIsLoggingOut(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Claude CLI Authenticated</CardTitle>
          <CardDescription>su-47 is ready to process Plane issues</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-3 rounded-lg border p-4">
            {status.email && (
              <div className="flex items-center gap-3 text-sm">
                <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Email</span>
                <span className="ml-auto font-medium">{status.email}</span>
              </div>
            )}

            {status.orgName && (
              <div className="flex items-center gap-3 text-sm">
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Organization</span>
                <span className="ml-auto font-medium">{status.orgName}</span>
              </div>
            )}

            {status.subscriptionType && (
              <div className="flex items-center gap-3 text-sm">
                <CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Plan</span>
                <span className="ml-auto font-medium capitalize">{status.subscriptionType}</span>
              </div>
            )}

            {status.authMethod && (
              <div className="flex items-center gap-3 text-sm">
                <Shield className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Auth method</span>
                <Badge variant="secondary" className="ml-auto capitalize">
                  {status.authMethod}
                </Badge>
              </div>
            )}
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            <LogOut className="h-4 w-4" />
            {isLoggingOut ? "Logging out..." : "Logout"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
