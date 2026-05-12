import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { SourcesAddPage } from "@executor-js/react/pages/sources-add";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/sources/add/$pluginKey")({
  validateSearch: SearchParams,
  component: () => {
    const { pluginKey } = Route.useParams();
    const { url, preset } = Route.useSearch();
    return <SourcesAddPage pluginKey={pluginKey} url={url} preset={preset} />;
  },
});
