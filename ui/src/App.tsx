import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuthStatus } from "@/hooks/useAuthStatus";
import { StatusPage } from "@/pages/StatusPage";
import { LoginPage } from "@/pages/LoginPage";
import { SetupTokenPage } from "@/pages/SetupTokenPage";

function AuthRouter() {
  const { status, isLoading, refetch } = useAuthStatus();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          status?.loggedIn ? (
            <StatusPage status={status} onLogout={refetch} />
          ) : (
            <LoginPage onSuccess={refetch} />
          )
        }
      />
      <Route
        path="/setup-token"
        element={
          status?.loggedIn ? (
            <Navigate to="/" replace />
          ) : (
            <SetupTokenPage onSuccess={refetch} />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthRouter />
    </BrowserRouter>
  );
}
