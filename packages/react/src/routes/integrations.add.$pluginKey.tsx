import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { AddIntegrationPage } from "../pages/integration-add";
import { consoleBasePath } from "./base-path";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/{-$orgSlug}/integrations/add/$pluginKey")({
  validateSearch: SearchParams,
  component: () => {
    const { pluginKey, orgSlug } = Route.useParams();
    const { url, preset, namespace, name, description } = Route.useSearch();
    return (
      <AddIntegrationPage
        basePath={consoleBasePath(orgSlug)}
        description={description}
        name={name}
        namespace={namespace}
        pluginKey={pluginKey}
        preset={preset}
        url={url}
      />
    );
  },
});
