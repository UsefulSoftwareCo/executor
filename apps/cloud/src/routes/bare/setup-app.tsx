import { createFileRoute } from "@tanstack/react-router";

import { SetupAppPage } from "../../web/pages/setup-app";

export const Route = createFileRoute("/setup-app")({
  component: SetupAppPage,
});
