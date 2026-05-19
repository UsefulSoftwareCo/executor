import { Effect, Match, Schema } from "effect";

import type { StorageFailure } from "./fuma-runtime";

import { credentialBindingKinds, type CredentialBindingRow } from "./core-schema";
import { ConnectionId, CredentialBindingId, ScopeId, SecretId } from "./ids";
import type { Usage } from "./usages";

export const CredentialBindingKind = Schema.Literals(credentialBindingKinds);
export type CredentialBindingKind = typeof CredentialBindingKind.Type;

export const CredentialBindingValue = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: SecretId,
    secretScopeId: Schema.optional(ScopeId),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: ConnectionId,
  }),
]);
export type CredentialBindingValue = typeof CredentialBindingValue.Type;

export const ConfiguredCredentialBinding = Schema.Struct({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: Schema.optional(Schema.String),
});
export type ConfiguredCredentialBinding = typeof ConfiguredCredentialBinding.Type;

export const ConfiguredCredentialValue = Schema.Union([Schema.String, ConfiguredCredentialBinding]);
export type ConfiguredCredentialValue = typeof ConfiguredCredentialValue.Type;

export const ScopedSecretCredentialInput = Schema.Struct({
  secretId: Schema.String,
  prefix: Schema.optional(Schema.String),
  targetScope: ScopeId,
  secretScopeId: Schema.optional(ScopeId),
});
export type ScopedSecretCredentialInput = typeof ScopedSecretCredentialInput.Type;

export const CredentialBindingRef = Schema.Struct({
  id: CredentialBindingId,
  scopeId: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  slotKey: Schema.String,
  value: CredentialBindingValue,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});
export type CredentialBindingRef = typeof CredentialBindingRef.Type;

export type SetPluginCredentialBindingInput = {
  readonly targetScope: ScopeId;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: ScopeId;
  readonly slotKey: string;
  readonly value: CredentialBindingValue;
};

export const CredentialBindingSourceInput = Schema.Struct({
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
});
export type CredentialBindingSourceInput = typeof CredentialBindingSourceInput.Type;

export const CredentialBindingSlotInput = Schema.Struct({
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotKey: Schema.String,
});
export type CredentialBindingSlotInput = typeof CredentialBindingSlotInput.Type;

export const RemoveCredentialBindingInput = Schema.Struct({
  targetScope: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotKey: Schema.String,
});
export type RemoveCredentialBindingInput = typeof RemoveCredentialBindingInput.Type;

export const ReplaceCredentialBindingValue = Schema.Struct({
  slotKey: Schema.String,
  value: CredentialBindingValue,
});
export type ReplaceCredentialBindingValue = typeof ReplaceCredentialBindingValue.Type;

export const ReplaceCredentialBindingsInput = Schema.Struct({
  targetScope: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotPrefixes: Schema.Array(Schema.String),
  bindings: Schema.Array(ReplaceCredentialBindingValue),
});
export type ReplaceCredentialBindingsInput = typeof ReplaceCredentialBindingsInput.Type;

export const SourceCredentialBindingSource = Schema.Struct({
  id: Schema.String,
  scope: ScopeId,
});
export type SourceCredentialBindingSource = typeof SourceCredentialBindingSource.Type;

export const SourceCredentialBindingSourceInput = Schema.Struct({
  source: SourceCredentialBindingSource,
});
export type SourceCredentialBindingSourceInput = typeof SourceCredentialBindingSourceInput.Type;

export const SourceCredentialBindingSlotInput = Schema.Struct({
  source: SourceCredentialBindingSource,
  slotKey: Schema.String,
});
export type SourceCredentialBindingSlotInput = typeof SourceCredentialBindingSlotInput.Type;

export const SetSourceCredentialBindingInput = Schema.Struct({
  scope: ScopeId,
  source: SourceCredentialBindingSource,
  slotKey: Schema.String,
  value: CredentialBindingValue,
});
export type SetSourceCredentialBindingInput = typeof SetSourceCredentialBindingInput.Type;

export const RemoveSourceCredentialBindingInput = Schema.Struct({
  scope: ScopeId,
  source: SourceCredentialBindingSource,
  slotKey: Schema.String,
});
export type RemoveSourceCredentialBindingInput = typeof RemoveSourceCredentialBindingInput.Type;

export const ReplaceSourceCredentialBindingsInput = Schema.Struct({
  scope: ScopeId,
  source: SourceCredentialBindingSource,
  slotPrefixes: Schema.Array(Schema.String),
  bindings: Schema.Array(ReplaceCredentialBindingValue),
});
export type ReplaceSourceCredentialBindingsInput = typeof ReplaceSourceCredentialBindingsInput.Type;

export const CredentialBindingResolutionStatus = Schema.Literals([
  "resolved",
  "missing",
  "blocked",
]);
export type CredentialBindingResolutionStatus = typeof CredentialBindingResolutionStatus.Type;

export const ResolvedCredentialSlot = Schema.Struct({
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  slotKey: Schema.String,
  bindingScopeId: Schema.NullOr(ScopeId),
  kind: Schema.NullOr(CredentialBindingKind),
  status: CredentialBindingResolutionStatus,
});
export type ResolvedCredentialSlot = typeof ResolvedCredentialSlot.Type;

export interface CredentialBindingsFacade {
  readonly listForSource: (
    input: CredentialBindingSourceInput,
  ) => Effect.Effect<readonly CredentialBindingRef[], StorageFailure>;
  readonly resolveBinding: (
    input: CredentialBindingSlotInput,
  ) => Effect.Effect<CredentialBindingRef | null, StorageFailure>;
  readonly resolve: (
    input: CredentialBindingSlotInput,
  ) => Effect.Effect<ResolvedCredentialSlot, StorageFailure>;
  readonly set: (
    input: SetPluginCredentialBindingInput,
  ) => Effect.Effect<CredentialBindingRef, StorageFailure>;
  readonly remove: (input: RemoveCredentialBindingInput) => Effect.Effect<void, StorageFailure>;
  readonly replaceForSource: (
    input: ReplaceCredentialBindingsInput,
  ) => Effect.Effect<readonly CredentialBindingRef[], StorageFailure>;
  readonly removeForSource: (
    input: CredentialBindingSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
  readonly usagesForSecret: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
  readonly usagesForConnection: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
}

export const credentialBindingId = (input: {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: string;
  readonly slotKey: string;
}): CredentialBindingId =>
  CredentialBindingId.make(
    JSON.stringify([input.pluginId, input.sourceScope, input.sourceId, input.slotKey]),
  );

export const credentialSlotPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

export const credentialSlotKey = (prefix: string, name: string): string =>
  `${prefix}:${credentialSlotPart(name)}`;

export const credentialBindingValueFromRow = (row: CredentialBindingRow): CredentialBindingValue =>
  Match.value(row).pipe(
    Match.when({ kind: "text" }, ({ text_value }) => ({
      kind: "text" as const,
      text: text_value,
    })),
    Match.when({ kind: "secret" }, ({ scope_id, secret_id, secret_scope_id }) => ({
      kind: "secret" as const,
      secretId: SecretId.make(secret_id),
      secretScopeId: ScopeId.make(secret_scope_id ?? scope_id),
    })),
    Match.when({ kind: "connection" }, ({ connection_id }) => ({
      kind: "connection" as const,
      connectionId: ConnectionId.make(connection_id),
    })),
    Match.exhaustive,
  );

export const credentialBindingRowToRef = (row: CredentialBindingRow): CredentialBindingRef => {
  const value = credentialBindingValueFromRow(row);
  return CredentialBindingRef.make({
    id: CredentialBindingId.make(row.id),
    scopeId: ScopeId.make(row.scope_id),
    pluginId: row.plugin_id,
    sourceId: row.source_id,
    sourceScopeId: ScopeId.make(row.source_scope_id),
    slotKey: row.slot_key,
    value,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  });
};
