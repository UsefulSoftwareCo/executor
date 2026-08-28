import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Auth — how to talk to 1Password
// ---------------------------------------------------------------------------

export const DesktopAppAuth = Schema.Struct({
  kind: Schema.Literal("desktop-app"),
  /** 1Password account domain, e.g. "my.1password.com" */
  accountName: Schema.String,
});
export type DesktopAppAuth = typeof DesktopAppAuth.Type;

export const ServiceAccountAuth = Schema.Struct({
  kind: Schema.Literal("service-account"),
  /** The service account token. Persisted in the plugin's owner-partitioned
   *  config blob — never surfaced to agents (`getConfig` redacts it). v1 stored
   *  this behind a separate secret id; v2 has no secrets table, so the
   *  plugin-owned config row carries it directly. */
  token: Schema.String,
});
export type ServiceAccountAuth = typeof ServiceAccountAuth.Type;

export const OnePasswordAuth = Schema.Union([DesktopAppAuth, ServiceAccountAuth]);
export type OnePasswordAuth = typeof OnePasswordAuth.Type;

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const Vault = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type Vault = typeof Vault.Type;

// ---------------------------------------------------------------------------
// Stored config — persisted via KV
// ---------------------------------------------------------------------------

export const OnePasswordConfig = Schema.Struct({
  auth: OnePasswordAuth,
  /** Vaults to scope operations to, in resolution-precedence order: bare item
   *  ids are looked up vault by vault and the first hit wins. */
  vaults: Schema.NonEmptyArray(Vault),
  /** Human label for the whole connection */
  name: Schema.String,
});
export type OnePasswordConfig = typeof OnePasswordConfig.Type;

/** Pre-multi-vault stored shape: a single vault id whose display name doubled
 *  as the connection label. Still accepted on read; every save writes the
 *  current shape, so a config row upgrades the first time it is re-saved. */
export const LegacyOnePasswordConfig = Schema.Struct({
  auth: OnePasswordAuth,
  vaultId: Schema.String,
  name: Schema.String,
});
export type LegacyOnePasswordConfig = typeof LegacyOnePasswordConfig.Type;

export const StoredOnePasswordConfig = Schema.Union([OnePasswordConfig, LegacyOnePasswordConfig]);
export type StoredOnePasswordConfig = typeof StoredOnePasswordConfig.Type;

export const normalizeStoredConfig = (stored: StoredOnePasswordConfig): OnePasswordConfig =>
  "vaultId" in stored
    ? {
        auth: stored.auth,
        vaults: [{ id: stored.vaultId, name: stored.name }],
        name: stored.name,
      }
    : stored;

// ---------------------------------------------------------------------------
// Redacted config — what `getConfig` returns to agents / the UI. The
// service-account token is stripped; only the auth kind + account metadata is
// surfaced.
// ---------------------------------------------------------------------------

export const RedactedDesktopAppAuth = DesktopAppAuth;

export const RedactedServiceAccountAuth = Schema.Struct({
  kind: Schema.Literal("service-account"),
});

export const RedactedOnePasswordAuth = Schema.Union([
  RedactedDesktopAppAuth,
  RedactedServiceAccountAuth,
]);

export const RedactedOnePasswordConfig = Schema.Struct({
  auth: RedactedOnePasswordAuth,
  vaults: Schema.NonEmptyArray(Vault),
  name: Schema.String,
});
export type RedactedOnePasswordConfig = typeof RedactedOnePasswordConfig.Type;

/** Strip the service-account token from a stored config for external exposure. */
export const redactConfig = (config: OnePasswordConfig): RedactedOnePasswordConfig => ({
  auth:
    config.auth.kind === "desktop-app"
      ? { kind: "desktop-app", accountName: config.auth.accountName }
      : { kind: "service-account" },
  vaults: config.vaults,
  name: config.name,
});

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export const ConnectionStatus = Schema.Struct({
  connected: Schema.Boolean,
  vaultNames: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String),
});
export type ConnectionStatus = typeof ConnectionStatus.Type;
