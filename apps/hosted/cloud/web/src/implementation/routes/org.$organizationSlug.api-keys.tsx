import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPage } from "@executor-js/hosted-web/pages/api-keys";

/** Named personal credentials in this organization. */
export const Route = createFileRoute("/org/$organizationSlug/api-keys")({ component: ApiKeysPage });
