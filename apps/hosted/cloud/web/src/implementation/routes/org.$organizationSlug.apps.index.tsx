import { createFileRoute } from "@tanstack/react-router";
import { AppsPage } from "@executor-js/hosted-web/pages/apps";

/** Hosted app inventory placeholder. */
export const Route = createFileRoute("/org/$organizationSlug/apps/")({ component: AppsPage });
