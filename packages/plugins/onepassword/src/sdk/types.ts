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
// Stored config — persisted via KV
// ---------------------------------------------------------------------------

export const OnePasswordConfig = Schema.Struct({
  auth: OnePasswordAuth,
  /** Vault to scope operations to */
  vaultId: Schema.String,
  /** Human label */
  name: Schema.String,
});
export type OnePasswordConfig = typeof OnePasswordConfig.Type;

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
  vaultId: Schema.String,
  name: Schema.String,
});
export type RedactedOnePasswordConfig = typeof RedactedOnePasswordConfig.Type;

/** Strip the service-account token from a stored config for external exposure. */
export const redactConfig = (config: OnePasswordConfig): RedactedOnePasswordConfig => ({
  auth:
    config.auth.kind === "desktop-app"
      ? { kind: "desktop-app", accountName: config.auth.accountName }
      : { kind: "service-account" },
  vaultId: config.vaultId,
  name: config.name,
});

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const Vault = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type Vault = typeof Vault.Type;

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export const ConnectionStatus = Schema.Struct({
  connected: Schema.Boolean,
  vaultName: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type ConnectionStatus = typeof ConnectionStatus.Type;
