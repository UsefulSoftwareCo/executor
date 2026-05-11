import { Effect, Match, Schema } from "effect";

import type { StorageFailure } from "@executor-js/storage-core";

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

export const ConfiguredCredentialBindingSchema = Schema.Struct({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: Schema.optional(Schema.String),
});

export class ConfiguredCredentialBinding extends Schema.Class<ConfiguredCredentialBinding>(
  "ConfiguredCredentialBinding",
)(ConfiguredCredentialBindingSchema.fields) {}

export const ConfiguredCredentialValue = Schema.Union([Schema.String, ConfiguredCredentialBinding]);
export type ConfiguredCredentialValue = typeof ConfiguredCredentialValue.Type;

export const ConfiguredCredentialValueSchema = Schema.Union([
  Schema.String,
  ConfiguredCredentialBindingSchema,
]);

export const ScopedSecretCredentialInput = Schema.Struct({
  secretId: Schema.String,
  prefix: Schema.optional(Schema.String),
  targetScope: ScopeId,
  secretScopeId: Schema.optional(ScopeId),
});
export type ScopedSecretCredentialInput = typeof ScopedSecretCredentialInput.Type;

export class CredentialBindingRef extends Schema.Class<CredentialBindingRef>(
  "CredentialBindingRef",
)({
  id: CredentialBindingId,
  scopeId: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  slotKey: Schema.String,
  value: CredentialBindingValue,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

export class SetCredentialBindingInput extends Schema.Class<SetCredentialBindingInput>(
  "SetCredentialBindingInput",
)({
  targetScope: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotKey: Schema.String,
  value: CredentialBindingValue,
}) {}

export class CredentialBindingSourceInput extends Schema.Class<CredentialBindingSourceInput>(
  "CredentialBindingSourceInput",
)({
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
}) {}

export class CredentialBindingSlotInput extends Schema.Class<CredentialBindingSlotInput>(
  "CredentialBindingSlotInput",
)({
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotKey: Schema.String,
}) {}

export class RemoveCredentialBindingInput extends Schema.Class<RemoveCredentialBindingInput>(
  "RemoveCredentialBindingInput",
)({
  targetScope: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotKey: Schema.String,
}) {}

export class ReplaceCredentialBindingValue extends Schema.Class<ReplaceCredentialBindingValue>(
  "ReplaceCredentialBindingValue",
)({
  slotKey: Schema.String,
  value: CredentialBindingValue,
}) {}

export class ReplaceCredentialBindingsInput extends Schema.Class<ReplaceCredentialBindingsInput>(
  "ReplaceCredentialBindingsInput",
)({
  targetScope: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
  slotPrefixes: Schema.Array(Schema.String),
  bindings: Schema.Array(ReplaceCredentialBindingValue),
}) {}

export const CredentialBindingResolutionStatus = Schema.Literals([
  "resolved",
  "missing",
  "blocked",
]);
export type CredentialBindingResolutionStatus = typeof CredentialBindingResolutionStatus.Type;

export class ResolvedCredentialSlot extends Schema.Class<ResolvedCredentialSlot>(
  "ResolvedCredentialSlot",
)({
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  slotKey: Schema.String,
  bindingScopeId: Schema.NullOr(ScopeId),
  kind: Schema.NullOr(CredentialBindingKind),
  status: CredentialBindingResolutionStatus,
}) {}

export interface CredentialBindingsFacade {
  readonly listForSource: (
    input: CredentialBindingSourceInput,
  ) => Effect.Effect<readonly CredentialBindingRef[], StorageFailure>;
  readonly resolve: (
    input: CredentialBindingSlotInput,
  ) => Effect.Effect<ResolvedCredentialSlot, StorageFailure>;
  readonly set: (
    input: SetCredentialBindingInput,
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
  return new CredentialBindingRef({
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
