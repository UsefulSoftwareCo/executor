import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAtom } from "@executor-js/react/api/atoms";
import { useScope, useScopeStack, useUserScope } from "@executor-js/react/api/scope-context";
import {
  SourceCredentialNotice,
  SourceCredentialStatusBadge,
  missingSourceCredentialLabels,
  type SourceCredentialSlot,
} from "@executor-js/react/plugins/source-credential-status";
import { ScopeId } from "@executor-js/sdk/core";

import { graphqlSourceAtom, graphqlSourceBindingsAtom } from "./atoms";
import type { StoredGraphqlSource } from "../sdk/store";

const sourceCredentialSlots = (source: StoredGraphqlSource): readonly SourceCredentialSlot[] => {
  const slots: SourceCredentialSlot[] = [];
  for (const [name, value] of Object.entries(source.headers)) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  for (const [name, value] of Object.entries(source.queryParams)) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  if (source.auth.kind === "oauth2") {
    slots.push({
      kind: "connection",
      slot: source.auth.connectionSlot,
      label: "OAuth sign-in",
    });
  }
  return slots;
};

export default function GraphqlSourceSummary(props: {
  sourceId: string;
  variant?: "badge" | "panel";
  onAction?: () => void;
}) {
  const displayScope = useScope();
  const userScope = useUserScope();
  const scopeStack = useScopeStack();
  const sourceResult = useAtomValue(graphqlSourceAtom(displayScope, props.sourceId));
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : displayScope;
  const bindingsResult = useAtomValue(
    graphqlSourceBindingsAtom(displayScope, props.sourceId, sourceScope),
  );
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));

  if (!source) return null;
  const slots = sourceCredentialSlots(source as StoredGraphqlSource);
  if (slots.length === 0) return null;
  if (!AsyncResult.isSuccess(bindingsResult) || !AsyncResult.isSuccess(connectionsResult)) {
    return props.variant === "panel" ? null : (
      <SourceCredentialStatusBadge missing={["credentials"]} />
    );
  }

  const scopeRanks = new Map(scopeStack.map((scope, index) => [scope.id, index] as const));
  const liveConnectionIds = new Set(connectionsResult.value.map((connection) => connection.id));
  const missing = missingSourceCredentialLabels({
    slots,
    bindings: bindingsResult.value,
    targetScope: userScope,
    scopeRanks,
    liveConnectionIds,
  });

  if (props.variant === "panel") {
    return <SourceCredentialNotice missing={missing} onAction={props.onAction} />;
  }

  return <SourceCredentialStatusBadge missing={missing} />;
}
