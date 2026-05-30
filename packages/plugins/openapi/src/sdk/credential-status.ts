import type { ConnectionId, CredentialBindingValue, ScopeId } from "@executor-js/sdk/shared";

import { oauth2ClientSecretSlot } from "./source-contracts";
import type { ConfiguredHeaderValue } from "./types";

export type BindingRowForCredentialStatus = {
  readonly slot: string;
  readonly scopeId: ScopeId;
  readonly value: CredentialBindingValue;
};

export type SourceForCredentialStatus = {
  readonly config: {
    readonly headers?: Record<string, ConfiguredHeaderValue>;
    readonly oauth2?: {
      readonly securitySchemeName: string;
      readonly flow: "authorizationCode" | "clientCredentials";
      readonly clientIdSlot: string;
      readonly clientSecretSlot: string | null;
      readonly connectionSlot: string;
    };
  };
};

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId) ?? Number.MAX_SAFE_INTEGER;

export const effectiveBindingForScope = (
  rows: readonly BindingRowForCredentialStatus[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): BindingRowForCredentialStatus | null =>
  rows
    .filter(
      (row) => row.slot === slot && scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
    )
    .sort((a, b) => scopeRank(ranks, a.scopeId) - scopeRank(ranks, b.scopeId))[0] ?? null;

const hasSecretBinding = (
  rows: readonly BindingRowForCredentialStatus[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) => effectiveBindingForScope(rows, slot, targetScope, ranks)?.value.kind === "secret";

const hasConnectionBinding = (
  rows: readonly BindingRowForCredentialStatus[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
  liveConnectionIds?: ReadonlySet<string>,
) => {
  const binding = effectiveBindingForScope(rows, slot, targetScope, ranks);
  if (binding?.value.kind !== "connection") return false;
  return liveConnectionIds ? liveConnectionIds.has(binding.value.connectionId) : true;
};

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

export function missingCredentialLabels(
  source: SourceForCredentialStatus,
  bindings: readonly BindingRowForCredentialStatus[],
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
  options?: {
    readonly liveConnectionIds?: ReadonlySet<string> | readonly ConnectionId[];
  },
): string[] {
  const missing: string[] = [];
  const rawLiveConnectionIds = options?.liveConnectionIds;
  const liveConnectionIds = rawLiveConnectionIds
    ? rawLiveConnectionIds instanceof Set
      ? rawLiveConnectionIds
      : new Set(rawLiveConnectionIds)
    : undefined;

  for (const [headerName, value] of Object.entries(source.config.headers ?? {})) {
    if (typeof value === "string") continue;
    if (!hasSecretBinding(bindings, value.slot, targetScope, ranks)) {
      missing.push(headerName);
    }
  }

  const oauth2 = source.config.oauth2;
  if (!oauth2) return missing;

  const hasLiveConnection = hasConnectionBinding(
    bindings,
    oauth2.connectionSlot,
    targetScope,
    ranks,
    liveConnectionIds,
  );
  if (!hasLiveConnection) {
    if (!hasSecretBinding(bindings, oauth2.clientIdSlot, targetScope, ranks)) {
      missing.push("Client ID");
    }

    const clientSecretSlot = effectiveClientSecretSlot(oauth2);
    if (!hasSecretBinding(bindings, clientSecretSlot, targetScope, ranks)) {
      missing.push("Client Secret");
    }

    missing.push(oauth2.flow === "clientCredentials" ? "OAuth client connection" : "OAuth sign-in");
  }

  return missing;
}
