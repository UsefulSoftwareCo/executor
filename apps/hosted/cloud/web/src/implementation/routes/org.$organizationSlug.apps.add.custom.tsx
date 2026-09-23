import { createFileRoute } from "@tanstack/react-router";
import { CustomAppPage } from "@executor-js/hosted-web/pages/custom-app";

/** Remote custom app setup is shared by both hosted products. */
export const Route = createFileRoute("/org/$organizationSlug/apps/add/custom")({
  component: CustomAppPage,
});
