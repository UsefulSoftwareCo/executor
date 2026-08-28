import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { AddIntegrationPage } from "../pages/integration-add";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    // Registry-declared credential placement, e.g. "Authorization: {api_key}".
    // Carried for surfaces whose connect target can't describe its own auth
    // (GraphQL endpoints have no spec document).
    authHeader: Schema.optional(Schema.String),
    authNote: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/{-$orgSlug}/integrations/add/$pluginKey")({
  validateSearch: SearchParams,
  component: () => {
    const { pluginKey } = Route.useParams();
    const { url, preset, namespace, authHeader, authNote } = Route.useSearch();
    return (
      <AddIntegrationPage
        pluginKey={pluginKey}
        url={url}
        preset={preset}
        namespace={namespace}
        authHeader={authHeader}
        authNote={authNote}
      />
    );
  },
});
