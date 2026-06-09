import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Option from "effect/Option";

import { IntegrationSlug } from "@executor-js/sdk/shared";
import { decodeGraphqlIntegrationConfigOption } from "@executor-js/plugin-graphql";

import { graphqlIntegrationConfigAtom } from "./atoms";
import GraphqlAccountsPanel from "./GraphqlAccountsPanel";

// ---------------------------------------------------------------------------
// Edit form — v2: custom authentication methods and connections live in the
// shared accounts hub. Keep edit and accounts on the same component path so
// GraphQL gets the same "+ Custom method" behavior as OpenAPI.
// ---------------------------------------------------------------------------

export default function EditGraphqlSource(props: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const slug = IntegrationSlug.make(props.sourceId);
  const configResult = useAtomValue(graphqlIntegrationConfigAtom(slug));
  const config = AsyncResult.isSuccess(configResult)
    ? Option.getOrNull(decodeGraphqlIntegrationConfigOption(configResult.value))
    : null;

  if (!AsyncResult.isSuccess(configResult) || !config) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-foreground">GraphQL Source</h1>
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }

  return (
    <GraphqlAccountsPanel
      sourceId={props.sourceId}
      integrationName={config.name || String(slug)}
      accountHandoff={null}
    />
  );
}
