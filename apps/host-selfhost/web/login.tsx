import { useState, type FormEvent } from "react";

import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";

import { authClient } from "./auth-client";

// Self-host login: email + password sign-in / sign-up via Better Auth. On
// success we reload so the shared AuthProvider re-reads /account/me and the
// AuthGate swaps in the app. (Cloud's equivalent is a WorkOS redirect — this
// is the provider-specific piece injected into the shared shell.)
export const LoginPage = () => {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result =
      mode === "signin"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? (mode === "signin" ? "Sign in failed" : "Sign up failed"));
      return;
    }
    window.location.href = "/";
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1 text-center">
          <h1 className="font-display text-2xl tracking-tight text-foreground">Executor</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to your instance" : "Create your account"}
          </p>
        </div>

        {mode === "signup" && (
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName((e.target as HTMLInputElement).value)}
              autoComplete="name"
              required
            />
          </div>
        )}
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
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={8}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </Button>

        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
          className="w-full text-sm font-normal text-muted-foreground hover:text-foreground"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </Button>
      </form>
    </div>
  );
};
