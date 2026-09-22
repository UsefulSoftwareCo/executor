import { createFileRoute } from "@tanstack/react-router";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";

/** Resolve an initial destination when no usable recent-organization hint exists. */
export const Route = createFileRoute("/")({ codeSplitGroupings: [], component: OrganizationEntry });
