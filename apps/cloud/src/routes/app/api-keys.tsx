import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPage, OrgApiKeysSection } from "@executor-js/react/pages/api-keys";

// Cloud renders the SHARED API-keys page over the provider-neutral
// `/account/api-keys` surface — identical UI to self-host, plus the
// cloud-only Organization keys section (self-host's provider refuses
// org keys; its admin plane is session-gated instead).
export const Route = createFileRoute("/{-$orgSlug}/api-keys")({
  component: CloudApiKeysPage,
});

function CloudApiKeysPage() {
  return <ApiKeysPage orgKeysSection={<OrgApiKeysSection />} />;
}
