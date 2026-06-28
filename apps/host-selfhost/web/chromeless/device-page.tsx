import { useEffect, useState } from "react";

import { Button } from "@executor-js/react/components/button";

// ---------------------------------------------------------------------------
// CLI device-login verification page. Better Auth's deviceAuthorization()
// plugin ships the JSON device API but no UI, so this is the page its
// `verificationUri` (/device) points at. `executor login` prints the code and
// opens this URL; the user confirms it and authorizes the device.
//
// Flow: on load we claim the pending code for the signed-in session (GET
// /api/auth/device?user_code, the plugin's bind step), then Approve/Deny POST
// to /api/auth/device/{approve,deny}. Like McpConsentPage, this is rendered
// chromeless INSIDE the auth gate (so the user is already signed in) via a
// static import in routes/__root.tsx, and drives the endpoints with plain fetch
// (the same convention the MCP consent screen uses).
// ---------------------------------------------------------------------------

type Phase = "binding" | "ready" | "approved" | "denied" | "error";

export const DevicePage = () => {
  const params = new URLSearchParams(globalThis.window?.location.search ?? "");
  const userCode = params.get("user_code") ?? "";
  const [phase, setPhase] = useState<Phase>("binding");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userCode) {
      setPhase("error");
      setError("This link is missing its device code.");
      return;
    }
    let alive = true;
    // Claim the pending code for this session; only the same session can then
    // approve or deny it.
    const bind = async () => {
      const res = await fetch(
        `${globalThis.location.origin}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
        { credentials: "include", headers: { accept: "application/json" } },
      );
      if (!alive) return;
      if (res.ok) {
        setPhase("ready");
      } else {
        setPhase("error");
        setError("This device code is unknown, already used, or expired.");
      }
    };
    void bind();
    return () => {
      alive = false;
    };
  }, [userCode]);

  const decide = async (accept: boolean) => {
    setBusy(accept ? "approve" : "deny");
    setError(null);
    const res = await fetch(
      `${globalThis.location.origin}/api/auth/device/${accept ? "approve" : "deny"}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      },
    );
    setBusy(null);
    if (!res.ok) {
      setError("Could not record your decision. The code may have expired, try again.");
      return;
    }
    setPhase(accept ? "approved" : "denied");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div
        id="device-approval"
        className="w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-6 text-center shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            Authorize this device
          </h1>
          <p className="text-sm text-muted-foreground">Confirm the code shown in your terminal.</p>
        </div>

        <div className="rounded-lg border border-border bg-background/50 p-4 font-mono text-2xl tracking-[0.3em] text-foreground">
          {userCode || "XXXX-XXXX"}
        </div>

        {phase === "binding" && <p className="text-sm text-muted-foreground">Checking the code…</p>}

        {phase === "ready" && (
          <>
            <p className="text-xs text-muted-foreground">
              A signed-in device will be able to act as your account through the CLI.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-3">
              <Button
                id="device-deny"
                type="button"
                variant="outline"
                className="flex-1"
                disabled={busy !== null}
                onClick={() => void decide(false)}
              >
                {busy === "deny" ? "Denying…" : "Deny"}
              </Button>
              <Button
                id="device-approve"
                type="button"
                className="flex-1"
                disabled={busy !== null}
                onClick={() => void decide(true)}
              >
                {busy === "approve" ? "Authorizing…" : "Authorize device"}
              </Button>
            </div>
          </>
        )}

        {phase === "approved" && (
          <p className="text-sm text-foreground">Device approved. Return to your terminal.</p>
        )}
        {phase === "denied" && (
          <p className="text-sm text-muted-foreground">
            Request denied. You can close this window.
          </p>
        )}
        {phase === "error" && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
};
