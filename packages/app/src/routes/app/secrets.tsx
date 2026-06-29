import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "@executor-js/react/pages/secrets";

// v2: the former "secrets" surface is now the credential-providers view. Bare
// secrets / scope prefill no longer exist (a connection IS the credential).
export const Route = createFileRoute("/{-$orgSlug}/secrets")({
  component: () => <SecretsPage showProviderInfo />,
});
