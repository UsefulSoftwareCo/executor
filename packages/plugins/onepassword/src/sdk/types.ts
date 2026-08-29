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
// Account — one named auth binding plus the vaults it scopes to. An owner can
// hold several (a work account and a personal one, or a service-account token
// next to desktop-app biometrics), each addressed by a stable generated id.
// ---------------------------------------------------------------------------

export const OnePasswordAccount = Schema.Struct({
  /** Stable identifier, generated when the account is first saved. Refs never
   *  embed it — `op://` addressing stays vault-first — so renaming or
   *  re-authing an account never invalidates a stored ref. */
  id: Schema.String,
  /** Human label for this account, e.g. "Work" */
  name: Schema.String,
  auth: OnePasswordAuth,
  /** Vaults to scope operations to. Order is presentational only: refs are
   *  vault-qualified, and a bare ref that matches in more than one vault is an
   *  explicit ambiguity failure, never a precedence pick. */
  vaults: Schema.NonEmptyArray(Vault),
});
export type OnePasswordAccount = typeof OnePasswordAccount.Type;

/** The account id every pre-multi-account config normalizes onto. */
export const DEFAULT_ACCOUNT_ID = "default";

// ---------------------------------------------------------------------------
// Stored config — persisted via KV
// ---------------------------------------------------------------------------

export const OnePasswordConfig = Schema.Struct({
  accounts: Schema.NonEmptyArray(OnePasswordAccount),
});
export type OnePasswordConfig = typeof OnePasswordConfig.Type;

/** Single-account stored shape (multi-vault, pre-multi-account). Still
 *  accepted on read; every save writes the current shape, so a config row
 *  upgrades the first time it is re-saved. */
export const SingleAccountOnePasswordConfig = Schema.Struct({
  auth: OnePasswordAuth,
  vaults: Schema.NonEmptyArray(Vault),
  name: Schema.String,
});
export type SingleAccountOnePasswordConfig = typeof SingleAccountOnePasswordConfig.Type;

/** Original stored shape: a single vault id whose display name doubled as the
 *  connection label. */
export const LegacyOnePasswordConfig = Schema.Struct({
  auth: OnePasswordAuth,
  vaultId: Schema.String,
  name: Schema.String,
});
export type LegacyOnePasswordConfig = typeof LegacyOnePasswordConfig.Type;

export const StoredOnePasswordConfig = Schema.Union([
  OnePasswordConfig,
  SingleAccountOnePasswordConfig,
  LegacyOnePasswordConfig,
]);
export type StoredOnePasswordConfig = typeof StoredOnePasswordConfig.Type;

export const normalizeStoredConfig = (stored: StoredOnePasswordConfig): OnePasswordConfig => {
  if ("accounts" in stored) return stored;
  if ("vaultId" in stored) {
    return {
      accounts: [
        {
          id: DEFAULT_ACCOUNT_ID,
          name: stored.name,
          auth: stored.auth,
          vaults: [{ id: stored.vaultId, name: stored.name }],
        },
      ],
    };
  }
  return {
    accounts: [
      { id: DEFAULT_ACCOUNT_ID, name: stored.name, auth: stored.auth, vaults: stored.vaults },
    ],
  };
};

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

export const RedactedOnePasswordAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  auth: RedactedOnePasswordAuth,
  vaults: Schema.NonEmptyArray(Vault),
});
export type RedactedOnePasswordAccount = typeof RedactedOnePasswordAccount.Type;

export const RedactedOnePasswordConfig = Schema.Struct({
  accounts: Schema.NonEmptyArray(RedactedOnePasswordAccount),
});
export type RedactedOnePasswordConfig = typeof RedactedOnePasswordConfig.Type;

const redactAuth = (auth: OnePasswordAuth): typeof RedactedOnePasswordAuth.Type =>
  auth.kind === "desktop-app"
    ? { kind: "desktop-app", accountName: auth.accountName }
    : { kind: "service-account" };

export const redactAccount = (account: OnePasswordAccount): RedactedOnePasswordAccount => ({
  id: account.id,
  name: account.name,
  auth: redactAuth(account.auth),
  vaults: account.vaults,
});

/** Strip the service-account tokens from a stored config for external exposure. */
export const redactConfig = (config: OnePasswordConfig): RedactedOnePasswordConfig => {
  const [first, ...rest] = config.accounts;
  return { accounts: [redactAccount(first), ...rest.map(redactAccount)] };
};

// ---------------------------------------------------------------------------
// Connection status — reported per account so one unreachable account never
// masks (or fakes) the health of another.
// ---------------------------------------------------------------------------

export const AccountStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  connected: Schema.Boolean,
  vaultNames: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String),
});
export type AccountStatus = typeof AccountStatus.Type;

export const ConnectionStatus = Schema.Struct({
  /** True only when configured and every account is reachable. */
  connected: Schema.Boolean,
  accounts: Schema.Array(AccountStatus),
  error: Schema.optional(Schema.String),
});
export type ConnectionStatus = typeof ConnectionStatus.Type;
