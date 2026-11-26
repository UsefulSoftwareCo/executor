import { createFileRoute } from "@tanstack/react-router";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";

export const Route = createFileRoute("/")({ codeSplitGroupings: [], component: OrganizationEntry });
