import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPage } from "@executor-js/react/pages/api-keys";

// Cloud renders the SHARED API-keys page over the provider-neutral
// `/account/api-keys` surface — identical UI to self-host.
export const Route = createFileRoute("/api-keys")({
  component: ApiKeysPage,
});
