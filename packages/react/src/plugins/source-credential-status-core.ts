import type { ConnectionId, CredentialBindingValue, ScopeId } from "@executor-js/sdk";

export type SourceCredentialSlot =
  | {
      readonly kind: "secret";
      readonly slot: string;
      readonly label: string;
      readonly optional?: boolean;
    }
  | {
      readonly kind: "connection";
      readonly slot: string;
      readonly label: string;
      readonly optional?: boolean;
    };

export type SourceCredentialBindingRef = {
  readonly slot: string;
  readonly scopeId: ScopeId;
  readonly value: CredentialBindingValue;
};

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId) ?? Number.MAX_SAFE_INTEGER;

export const effectiveSourceCredentialBinding = (
  rows: readonly SourceCredentialBindingRef[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): SourceCredentialBindingRef | null =>
  rows
    .filter(
      (row) => row.slot === slot && scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
    )
    .sort((a, b) => scopeRank(ranks, a.scopeId) - scopeRank(ranks, b.scopeId))[0] ?? null;

const liveConnectionSet = (
  values?: ReadonlySet<string> | readonly ConnectionId[],
): ReadonlySet<string> | undefined => (values ? new Set(Array.from(values, String)) : undefined);

export const missingSourceCredentialLabels = (input: {
  readonly slots: readonly SourceCredentialSlot[];
  readonly bindings: readonly SourceCredentialBindingRef[];
  readonly targetScope: ScopeId;
  readonly scopeRanks: ReadonlyMap<string, number>;
  readonly liveConnectionIds?: ReadonlySet<string> | readonly ConnectionId[];
}): string[] => {
  const liveConnections = liveConnectionSet(input.liveConnectionIds);
  const missing: string[] = [];

  for (const slot of input.slots) {
    if (slot.optional) continue;
    const binding = effectiveSourceCredentialBinding(
      input.bindings,
      slot.slot,
      input.targetScope,
      input.scopeRanks,
    );

    if (slot.kind === "secret" && binding?.value.kind !== "secret") {
      missing.push(slot.label);
      continue;
    }

    if (slot.kind === "connection") {
      if (binding?.value.kind !== "connection") {
        missing.push(slot.label);
        continue;
      }
      if (liveConnections && !liveConnections.has(binding.value.connectionId)) {
        missing.push(slot.label);
      }
    }
  }

  return missing;
};
