import { createFileRoute } from "@tanstack/react-router";

import { SecretsPage } from "../pages/secrets";

// The Providers/Secrets page lets users inspect their credential backends.
// Credential entry happens through the per-integration Add Account flow
// (`connections.createHandoff` → `/integrations/{slug}?addAccount=1`), not
// here, so this route takes no search params. Apps with a different secrets
// surface (e.g. cloud hides it) exclude this route and bring their own file.
export const Route = createFileRoute("/{-$orgSlug}/secrets")({
  component: () => <SecretsPage />,
});
