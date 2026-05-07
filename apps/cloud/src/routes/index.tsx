import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAuth } from "../web/auth";

export const Route = createFileRoute("/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  const auth = useAuth();
  const navigate = useNavigate();
  const firstHandle =
    auth.status === "authenticated" ? (auth.organizations[0]?.handle ?? null) : null;

  useEffect(() => {
    if (!firstHandle) return;
    void navigate({ to: "/$org", params: { org: firstHandle }, replace: true });
  }, [firstHandle, navigate]);

  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}
