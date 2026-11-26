import { createFileRoute } from "@tanstack/react-router";
import { AddAppPage } from "@executor-js/hosted-web/pages/add-app";

export const Route = createFileRoute("/org/$organizationSlug/apps/add/")({ component: AddAppPage });
