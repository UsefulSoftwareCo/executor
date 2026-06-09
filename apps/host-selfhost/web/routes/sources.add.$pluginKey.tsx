import { Schema } from "effect";
import { createFileRoute, redirect } from "@tanstack/react-router";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/sources/add/$pluginKey")({
  validateSearch: SearchParams,
  beforeLoad: ({ params, search }) => {
    const { pluginKey } = params;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router redirects are modeled as thrown values
    throw redirect({ to: "/integrations/add/$pluginKey", params: { pluginKey }, search });
  },
});
