import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "@executor-js/react/pages/secrets";

export const Route = createFileRoute("/secrets")({
  component: SecretsPage,
});
