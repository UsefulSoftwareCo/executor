import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useAuth } from "../auth";

/** Waits for the organization write after creation before entering the scoped app picker. */
export const SetupAppPage = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const organizationSlug =
    auth.status === "authenticated" ? (auth.organization?.slug ?? null) : null;

  useEffect(() => {
    if (!organizationSlug) return;
    void navigate({
      to: "/{-$orgSlug}/integrations/browse",
      params: { orgSlug: organizationSlug },
      search: { onboarding: 1 },
      replace: true,
    });
  }, [navigate, organizationSlug]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Step 2 of 3
        </p>
        <h1 className="mt-2 font-sans text-3xl font-semibold">Choose your first app</h1>
        <p className="mt-2 text-sm text-muted-foreground">Preparing your workspace...</p>
      </section>
    </main>
  );
};
