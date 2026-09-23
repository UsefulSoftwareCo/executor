import { createFileRoute } from "@tanstack/react-router";
import { AddAppPage } from "@executor-js/hosted-web/pages/add-app";

/** App selection and installation belong to Apps, as in local. */
export const Route = createFileRoute("/org/$organizationSlug/apps/add/")({ component: AddAppPage });
