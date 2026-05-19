import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { SecretsPage } from "@executor-js/react/pages/secrets";

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
    const { name, secretId, provider, scope } = Route.useSearch();
    const hasPrefill = name != null || secretId != null;
    return (
      <SecretsPage
        addSecretDescription="Store a credential or API key for this organization."
        showProviderInfo={false}
        storageOptions={[{ value: "workos-vault", label: "WorkOS Vault" }]}
        prefill={hasPrefill ? { name, secretId, provider, scope } : undefined}
      />
    );
  },
});
