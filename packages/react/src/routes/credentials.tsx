import { createFileRoute } from "@tanstack/react-router";

import { CredentialsPage } from "../pages/credentials";

export const Route = createFileRoute("/{-$orgSlug}/credentials")({
  component: () => <CredentialsPage />,
});
