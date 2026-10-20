import { createFileRoute } from "@tanstack/react-router";

import { DelegatedCredentialsPage } from "../pages/delegated-credentials";

export const Route = createFileRoute("/{-$orgSlug}/delegated-credentials")({
  component: DelegatedCredentialsPage,
});
