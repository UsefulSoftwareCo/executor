import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@executor-js/react/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@executor-js/react/components/card";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";

import { authClient } from "../../auth-client";

export const Route = createFileRoute("/join/$code")({
  component: JoinPage,
});

// Public, chromeless account-creation page. Reached at /join/<code>: the code
// is the credential that lets a new person self-register. It rides on the
// signup request body; the server's create gate validates + burns it and drops
// the new user into the org as a member. The root renders this outside the
// auth gate (an un-redeemed visitor has no session yet).
function JoinPage() {
  const { code } = Route.useParams();
  const [inviteState, setInviteState] = useState<"checking" | "valid" | "invalid">("checking");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setInviteState("checking");
    void fetch(`/api/invite-status/${encodeURIComponent(code)}`, {
      credentials: "same-origin",
    }).then(
      async (response) => {
        const body = response.ok
          ? ((await response.json().then(
              (value) => value,
              () => ({}),
            )) as { valid?: boolean })
          : {};
        if (alive) setInviteState(body.valid === true ? "valid" : "invalid");
      },
      () => {
        if (alive) setInviteState("invalid");
      },
    );
    return () => {
      alive = false;
    };
  }, [code]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // The Better Auth client forwards `inviteCode` (a non-schema field) onto the
    // signup body the create gate reads; same-origin, so the session cookie
    // sticks. Returns `{ error }` rather than throwing — no manual fetch.
    const result = await authClient.signUp.email({ name, email, password, inviteCode: code });
    if (result.error) {
      setBusy(false);
      setError(
        result.error.message ??
          "Could not create your account. Check your invite link and try again.",
      );
      return;
    }
    window.location.href = "/";
  };

  if (inviteState === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (inviteState === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invite not valid</CardTitle>
            <CardDescription>
              This invite link is invalid or has expired. Ask the person who invited you for a new
              link.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1 text-center">
          <h1 className="font-display text-2xl tracking-tight text-foreground">Join Executor</h1>
          <p className="text-sm text-muted-foreground">
            You've been invited — create your account.
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

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </div>
  );
}
