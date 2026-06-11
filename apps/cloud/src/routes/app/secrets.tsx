import { createFileRoute, redirect } from "@tanstack/react-router";

// Cloud keeps credential storage as product plumbing, not a user-facing section.
// Preserve the route for generated router compatibility and stale links, but
// redirect away from the provider internals page.
export const Route = createFileRoute("/secrets")({
  beforeLoad: () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router redirects are modeled as thrown values
    throw redirect({ to: "/" });
  },
});
