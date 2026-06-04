import { useState, type FormEvent } from "react";

import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";

import { authClient } from "./auth-client";

// Self-host login: email + password sign-in via Better Auth. On success we
// reload so the shared AuthProvider re-reads /account/me and the AuthGate swaps
// in the app. (Cloud's equivalent is a WorkOS redirect — this is the
// provider-specific piece injected into the shared shell.)
//
// There is no self-signup here: open registration is closed. New people join by
// redeeming an invite — either the full /join/<code> link, or by entering the
// code here ("Have an invite code?"), which forwards to the same join page.
export const LoginPage = () => {
  const [mode, setMode] = useState<"signin" | "code">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? "Sign in failed");
      return;
    }
    window.location.href = "/";
  };

  const redeem = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    // Forward to the join page, which collects name/email/password and redeems.
    window.location.href = `/join/${encodeURIComponent(trimmed)}`;
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="space-y-1 text-center">
          <h1 className="font-display text-2xl tracking-tight text-foreground">Executor</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to your instance" : "Join with your invite code"}
          </p>
        </div>

        {mode === "signin" ? (
          <form onSubmit={signIn} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
                autoComplete="current-password"
                required
                minLength={8}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <form onSubmit={redeem} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-code">Invite code</Label>
              <Input
                id="invite-code"
                placeholder="XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode((e.target as HTMLInputElement).value)}
                autoFocus
              />
            </div>
            <Button type="submit" disabled={!code.trim()} className="w-full">
              Continue
            </Button>
          </form>
        )}

        <div className="text-center">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setMode(mode === "signin" ? "code" : "signin");
              setError(null);
            }}
            className="text-sm font-normal text-muted-foreground hover:text-foreground"
          >
            {mode === "signin" ? "Have an invite code? Join" : "Already have an account? Sign in"}
          </Button>
        </div>
      </div>
    </div>
  );
};
