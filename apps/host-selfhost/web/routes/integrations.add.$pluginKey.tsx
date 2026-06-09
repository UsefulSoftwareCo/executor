import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { AddIntegrationPage } from "@executor-js/react/pages/integration-add";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/integrations/add/$pluginKey")({
  validateSearch: SearchParams,
  component: () => {
    const { pluginKey } = Route.useParams();
    const { url, preset, namespace } = Route.useSearch();
    return (
      <AddIntegrationPage pluginKey={pluginKey} url={url} preset={preset} namespace={namespace} />
    );
  },
});
