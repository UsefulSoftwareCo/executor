import { Schema } from "effect";
import { ConnectionSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectAccountPage } from "@executor-js/hosted-web/pages/connect-account";

export const Route = createFileRoute("/org/$organizationSlug/connections/$connectionId")({
  validateSearch: Schema.decodeUnknownSync(ConnectionSearch),
  component: () => (
    <ConnectAccountPage
      connectionId={Route.useParams().connectionId}
      client={Route.useSearch().client}
    />
  ),
});
