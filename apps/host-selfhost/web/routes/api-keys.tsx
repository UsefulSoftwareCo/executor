import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPage } from "@executor-js/react/pages/api-keys";

export const Route = createFileRoute("/api-keys")({
  component: ApiKeysPage,
});
