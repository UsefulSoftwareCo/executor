import { createFileRoute } from "@tanstack/react-router";
import { AppsPage, appsPageReads } from "@executor-js/hosted-web/pages/apps";

/** Hosted app inventory placeholder. */
export const Route = createFileRoute("/org/$organizationSlug/apps/")({
  component: AppsPage,
  staticData: { organizationReads: appsPageReads },
});
