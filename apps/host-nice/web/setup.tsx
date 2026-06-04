import { useState, type FormEvent } from "react";

import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";

import { authClient } from "./auth-client";

// First-run setup. A fresh instance has no users, so the first visitor creates
// the admin account here. The server admits the first signup into the empty org
// as its owner (no invite code needed); once anyone is a member, signup is
// invite-gated and this page is never shown again. The auth gate renders this
// when /api/setup-status reports the instance still needs setup.
export const SetupPage = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signUp.email({ name, email, password });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? "Could not create the admin account.");
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
          <h1 className="font-display text-2xl tracking-tight text-foreground">Set up Executor</h1>
          <p className="text-sm text-muted-foreground">
            Create the admin account for this instance.
          </p>
        </div>

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
            autoComplete="new-password"
            required
            minLength={8}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating…" : "Create admin account"}
        </Button>
      </form>
    </div>
  );
};
