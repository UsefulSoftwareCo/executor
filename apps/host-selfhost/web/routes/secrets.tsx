import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "@executor-js/react/pages/secrets";

// The Providers/Secrets page lets self-host users inspect their credential
// backends. Credential entry happens through the per-integration Add Account
// flow (`connections.createHandoff` → `/integrations/{slug}?addAccount=1`),
// not here, so this route takes no search params.
export const Route = createFileRoute("/secrets")({
  component: () => <SecretsPage />,
});
