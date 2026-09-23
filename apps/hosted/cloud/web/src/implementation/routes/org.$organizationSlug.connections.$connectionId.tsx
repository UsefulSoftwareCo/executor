import { Schema } from "effect";
import { ConnectionSearch } from "@executor-js/hosted-web/contracts/navigation";
import { createFileRoute } from "@tanstack/react-router";
import { ConnectionEntry } from "@executor-js/hosted-web/pages/connection-dialog";

export const Route = createFileRoute("/org/$organizationSlug/connections/$connectionId")({
  validateSearch: Schema.decodeUnknownSync(ConnectionSearch),
  component: () => (
    <ConnectionEntry
      connectionId={Route.useParams().connectionId}
      client={Route.useSearch().client}
    />
  ),
});
