import { createFileRoute } from "@tanstack/react-router";
import { ConnectPage, connectPageReads } from "@executor-js/hosted-web/pages/connect";

export const Route = createFileRoute("/org/$organizationSlug/connect")({
  component: ConnectPage,
  staticData: { organizationReads: connectPageReads },
});
