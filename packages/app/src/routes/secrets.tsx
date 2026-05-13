import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "@executor-js/react/pages/secrets";

// Query params supported by the agent-facing `secrets.create` static tool:
// it builds a URL like `/secrets?name=…&scope=…&secretId=…` and hands
// it to the user. The page opens the add modal pre-filled when any
// prefill field is present so the user only has to type the value.
const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    secretId: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
    scope: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/secrets")({
  validateSearch: SearchParams,
  component: () => {
    const { name, secretId, provider } = Route.useSearch();
    const hasPrefill = name != null || secretId != null;
    return <SecretsPage prefill={hasPrefill ? { name, secretId, provider } : undefined} />;
  },
});
