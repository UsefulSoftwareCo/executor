import { Cache, Data, Duration, Effect, Exit, Schema } from "effect";

import {
  definePlugin,
  StorageError,
  ToolResult,
  tool,
  ProviderItemId,
  ProviderKey,
  type CredentialProvider,
  type Owner,
  type PluginCtx,
  type PluginBlobStore,
  type ProviderEntry,
  type StaticToolSchema,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  OnePasswordAccount,
  OnePasswordAuth,
  OnePasswordConfig,
  RedactedOnePasswordConfig,
  StoredOnePasswordConfig,
  Vault,
  ConnectionStatus,
  AccountStatus,
  normalizeStoredConfig,
  redactConfig,
} from "./types";
import { OnePasswordError } from "./errors";
import { makeOnePasswordService, type ResolvedAuth, type OnePasswordService } from "./service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIAL_FIELD = "credential";
const DEFAULT_TIMEOUT_MS = 15_000;
// How long a resolved secret may be served from memory before 1Password is
// asked again. Every 1Password read is at least one `op` spawn or SDK IPC
// round trip (~1s with desktop-app auth), and the executor resolves the
// connection's credential on every tool call — uncached, a 1Password-backed
// connection multiplied each call's latency several times over. One minute
// keeps a revoked or rotated item's window small while collapsing an agent's
// call burst onto a single backend read. This cache is deliberately scoped to
// this plugin; other credential providers stay uncached.
const DEFAULT_SECRET_CACHE_TTL_MS = 60_000;
const SECRET_CACHE_CAPACITY = 256;
const SERVICE_CACHE_CAPACITY = 16;
const CONFIG_KEY = "config";
const PROVIDER_KEY = ProviderKey.make("onepassword");

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

// ---------------------------------------------------------------------------
// Upsert payload — `configure` adds or replaces one account. The id is
// generated on first save so the caller can address the account later
// (edit, remove) without the name doubling as an identifier.
// ---------------------------------------------------------------------------

export const OnePasswordAccountUpsert = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  auth: OnePasswordAuth,
  vaults: Schema.NonEmptyArray(Vault),
});
export type OnePasswordAccountUpsert = typeof OnePasswordAccountUpsert.Type;

const OnePasswordConfigureInput = OnePasswordAccountUpsert;

const OnePasswordConfigureOutput = Schema.Struct({
  configured: Schema.Boolean,
  accountId: Schema.String,
});

const OnePasswordGetConfigOutput = Schema.Struct({
  config: Schema.NullOr(RedactedOnePasswordConfig),
});

const OnePasswordListVaultsInput = OnePasswordAuth;

const OnePasswordListVaultsOutput = Schema.Struct({
  vaults: Schema.Array(Vault),
});

const OnePasswordRemoveConfigInput = Schema.Struct({
  accountId: Schema.optional(Schema.String),
});

const OnePasswordRemoveConfigOutput = Schema.Struct({
  removed: Schema.Boolean,
});

const OnePasswordStatusOutput = ConnectionStatus;

const OnePasswordConfigureInputStd = schemaToStaticToolSchema<
  typeof OnePasswordConfigureInput.Type,
  typeof OnePasswordConfigureInput.Encoded
>(OnePasswordConfigureInput);
const OnePasswordConfigureOutputStd = schemaToStaticToolSchema(OnePasswordConfigureOutput);
const OnePasswordGetConfigOutputStd = schemaToStaticToolSchema(OnePasswordGetConfigOutput);
const OnePasswordListVaultsInputStd = schemaToStaticToolSchema<
  typeof OnePasswordListVaultsInput.Type,
  typeof OnePasswordListVaultsInput.Encoded
>(OnePasswordListVaultsInput);
const OnePasswordListVaultsOutputStd = schemaToStaticToolSchema(OnePasswordListVaultsOutput);
const OnePasswordRemoveConfigInputStd = schemaToStaticToolSchema<
  typeof OnePasswordRemoveConfigInput.Type,
  typeof OnePasswordRemoveConfigInput.Encoded
>(OnePasswordRemoveConfigInput);
const OnePasswordRemoveConfigOutputStd = schemaToStaticToolSchema(OnePasswordRemoveConfigOutput);
const OnePasswordStatusOutputStd = schemaToStaticToolSchema(OnePasswordStatusOutput);

// ---------------------------------------------------------------------------
// Shared failure alias.
//
// Every extension method either touches storage (`ctx.storage` blobs) or
// reaches the 1Password backend. Storage I/O surfaces as `StorageFailure`;
// the HTTP edge (`withCapture`) translates `StorageError` to
// `InternalError({ traceId })`. Domain problems (not configured, backend RPC
// failure) stay as `OnePasswordError` and encode to 502 via the schema
// annotation on the class.
// ---------------------------------------------------------------------------

export type OnePasswordExtensionFailure = OnePasswordError | StorageFailure;

// ---------------------------------------------------------------------------
// Typed config store — single blob, JSON encoded, owner-partitioned. The
// stored config carries every account's auth credential (desktop account
// name, or service-account token) plus its selected vaults. v1 keyed this by
// executor scope; v2 partitions by `owner` — the plugin-owned config row owns
// the partition, mirroring the connection model. Reads also accept the two
// pre-multi-account shapes and normalize them onto a single "default"
// account; saves always write the current shape. Blob I/O failures surface as
// `StorageError`; decode failures stay `OnePasswordError`.
// ---------------------------------------------------------------------------

export interface OnePasswordStore {
  readonly getConfig: () => Effect.Effect<
    OnePasswordConfig | null,
    StorageError | OnePasswordError
  >;
  readonly saveConfig: (
    config: OnePasswordConfig,
    owner: Owner,
  ) => Effect.Effect<void, StorageError>;
  readonly deleteConfig: (owner: Owner) => Effect.Effect<void, StorageError>;
}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredOnePasswordConfig));

const blobStorageError =
  (operation: string) =>
  (cause: unknown): StorageError =>
    new StorageError({
      message: `onepassword blob ${operation} failed`,
      cause,
    });

export const makeOnePasswordStore = (blobs: PluginBlobStore): OnePasswordStore => ({
  getConfig: () =>
    blobs.get(CONFIG_KEY).pipe(
      Effect.mapError(blobStorageError("read")),
      Effect.flatMap((raw) => {
        if (raw === null) return Effect.succeed(null);
        return decodeConfig(raw).pipe(
          Effect.map(normalizeStoredConfig),
          Effect.mapError(
            () =>
              new OnePasswordError({
                operation: "config decode",
                message: "Failed to decode 1Password config",
              }),
          ),
        );
      }),
    ),

  saveConfig: (config, owner) =>
    blobs
      .put(CONFIG_KEY, JSON.stringify({ accounts: config.accounts }), { owner })
      .pipe(Effect.mapError(blobStorageError("write"))),

  deleteConfig: (owner) =>
    blobs.delete(CONFIG_KEY, { owner }).pipe(Effect.mapError(blobStorageError("delete"))),
});

// ---------------------------------------------------------------------------
// Helpers — auth resolution + service construction
// ---------------------------------------------------------------------------

const resolveAuth = (auth: OnePasswordAuth): ResolvedAuth =>
  auth.kind === "desktop-app"
    ? { kind: "desktop-app", accountName: auth.accountName }
    : { kind: "service-account", token: auth.token };

/** Cache keys with structural equality (`Data.Class`), one per auth shape so
 *  the two kinds can never collide. Every account row carrying the same
 *  credential identity maps onto one cached service. */
class DesktopAuthKey extends Data.Class<{ readonly accountName: string }> {}
class ServiceAccountKey extends Data.Class<{ readonly token: string }> {}
type AuthKey = DesktopAuthKey | ServiceAccountKey;

const authKey = (auth: ResolvedAuth): AuthKey =>
  auth.kind === "desktop-app"
    ? new DesktopAuthKey({ accountName: auth.accountName })
    : new ServiceAccountKey({ token: auth.token });

const authFromKey = (key: AuthKey): ResolvedAuth =>
  key instanceof DesktopAuthKey
    ? { kind: "desktop-app", accountName: key.accountName }
    : { kind: "service-account", token: key.token };

/** One service per auth identity, memoized for the plugin instance's
 *  lifetime. Keying by the resolved auth keeps accounts isolated (a shared
 *  client can never leak one account's credential into another's calls) while
 *  reusing the constructed service — and with it the SDK backend's cached
 *  client — across calls instead of re-authenticating per resolution.
 *  Construction failures are not retained, so a transient backend problem
 *  does not poison the account until restart. */
export const makeServiceForAuth = (
  timeoutMs: number,
  preferSdk: boolean | undefined,
): ((auth: OnePasswordAuth) => Effect.Effect<OnePasswordService, OnePasswordError>) => {
  const cache = Effect.runSync(
    Cache.makeWith(
      (key: AuthKey) => makeOnePasswordService(authFromKey(key), { timeoutMs, preferSdk }),
      {
        capacity: SERVICE_CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    ),
  );
  return (auth) => Cache.get(cache, authKey(resolveAuth(auth)));
};

type ServiceForAccount = (
  account: OnePasswordAccount,
) => Effect.Effect<OnePasswordService, OnePasswordError>;

// ---------------------------------------------------------------------------
// Explicit ref resolution.
//
// A ref is one of:
//   - `op://vault/item/field...` — fully qualified, resolved as-is via the
//                                 account that owns the vault. The first
//                                 segment stays a VAULT (id or name),
//                                 matching 1Password's own op:// semantics —
//                                 account selection is derived, never
//                                 encoded into the ref.
//   - `op://vault/item`         — picker-shaped; the default credential field
//                                 is appended. This is the id shape `list()`
//                                 hands out, so every picked item permanently
//                                 records which vault it came from.
//   - a bare item id or title   — located by listing every account's
//                                 configured vaults. Exactly one match
//                                 resolves; several matches are an explicit
//                                 ambiguity failure naming the vaults — never
//                                 a precedence pick.
// ---------------------------------------------------------------------------

export type RefResolution =
  | { readonly kind: "resolved"; readonly value: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "outside-vaults" }
  | {
      readonly kind: "ambiguous";
      readonly matches: readonly {
        readonly accountName: string;
        readonly vaultId: string;
        readonly vaultName: string;
        readonly itemId: string;
        readonly itemTitle: string;
      }[];
    }
  | {
      readonly kind: "ambiguous-vault";
      readonly vaultName: string;
      readonly matches: readonly {
        readonly accountName: string;
        readonly vaultId: string;
      }[];
    };

export const ambiguityMessage = (
  ref: string,
  matches: Extract<RefResolution, { kind: "ambiguous" }>["matches"],
): string =>
  [
    `1Password ref "${ref}" is ambiguous: it matches`,
    matches
      .map((m) => `"${m.itemTitle}" in vault "${m.vaultName}" (account "${m.accountName}")`)
      .join(", "),
    `. Use op://<vaultId>/<itemId> to pick one.`,
  ].join(" ");

export const vaultAmbiguityMessage = (
  resolution: Extract<RefResolution, { kind: "ambiguous-vault" }>,
): string =>
  [
    `1Password vault name "${resolution.vaultName}" is configured in more than one account:`,
    resolution.matches.map((m) => `"${m.accountName}" (vault id ${m.vaultId})`).join(", "),
    `. Use op://<vaultId>/... to pick one.`,
  ].join(" ");

/** Resolve a ref against every configured account. Backend failures stay on
 *  the error channel; every addressing outcome is an explicit
 *  `RefResolution`. Services are built per account and only for the accounts
 *  a ref actually needs. */
export const resolveConfiguredRef = (
  config: OnePasswordConfig,
  serviceFor: (account: OnePasswordAccount) => Effect.Effect<OnePasswordService, OnePasswordError>,
  ref: string,
): Effect.Effect<RefResolution, OnePasswordError> => {
  if (ref.startsWith("op://")) {
    const segments = ref.slice("op://".length).split("/");
    const vaultSegment = segments[0];
    if (segments.length < 2 || vaultSegment === undefined || segments.includes("")) {
      return Effect.succeed({ kind: "not-found" });
    }
    const uri = segments.length === 2 ? `${ref}/${CREDENTIAL_FIELD}` : ref;

    // Vault ids are globally unique, so an id-addressed ref names one vault no
    // matter how many accounts configure it — any owning account can serve it.
    const idOwner = config.accounts.find((account) =>
      account.vaults.some((vault) => vault.id === vaultSegment),
    );
    if (idOwner !== undefined) {
      return serviceFor(idOwner).pipe(
        Effect.flatMap((svc) => svc.resolveSecret(uri)),
        Effect.map((value): RefResolution => ({ kind: "resolved", value })),
      );
    }

    // Vault names are only unique per account: the same name in two accounts
    // is two different vaults, so a name-addressed ref must be an explicit
    // ambiguity, never a precedence pick.
    const nameOwners = config.accounts.flatMap((account) =>
      account.vaults
        .filter((vault) => vault.name === vaultSegment)
        .map((vault) => ({ account, vault })),
    );
    const [onlyOwner, ...extraOwners] = nameOwners;
    if (onlyOwner === undefined) return Effect.succeed({ kind: "outside-vaults" });
    if (extraOwners.length > 0) {
      return Effect.succeed({
        kind: "ambiguous-vault",
        vaultName: vaultSegment,
        matches: nameOwners.map((owner) => ({
          accountName: owner.account.name,
          vaultId: owner.vault.id,
        })),
      });
    }
    return serviceFor(onlyOwner.account).pipe(
      Effect.flatMap((svc) => svc.resolveSecret(uri)),
      Effect.map((value): RefResolution => ({ kind: "resolved", value })),
    );
  }

  return Effect.gen(function* () {
    const matches = (yield* Effect.forEach(config.accounts, (account) =>
      serviceFor(account).pipe(
        Effect.flatMap((svc) =>
          Effect.forEach(account.vaults, (vault) =>
            svc.listItems(vault.id).pipe(
              Effect.map((items) =>
                items
                  .filter((item) => item.id === ref || item.title === ref)
                  .map((item) => ({
                    accountId: account.id,
                    accountName: account.name,
                    vaultId: vault.id,
                    vaultName: vault.name,
                    itemId: item.id,
                    itemTitle: item.title,
                  })),
              ),
            ),
          ),
        ),
        Effect.map((groups) => groups.flat()),
      ),
    )).flat();

    const [only, ...extra] = matches;
    if (only === undefined) return { kind: "not-found" } as const;
    if (extra.length > 0) {
      return {
        kind: "ambiguous",
        matches: matches.map(({ accountId: _accountId, ...match }) => match),
      } as const;
    }

    const owner = config.accounts.find((account) => account.id === only.accountId);
    if (owner === undefined) return { kind: "not-found" } as const;
    const svc = yield* serviceFor(owner);
    const value = yield* svc.resolveSecret(
      `op://${only.vaultId}/${only.itemId}/${CREDENTIAL_FIELD}`,
    );
    return { kind: "resolved", value } as const;
  });
};

// ---------------------------------------------------------------------------
// Cached ref resolution — the hot path.
//
// The executor resolves a connection's credential on EVERY tool call, and for
// this provider each resolution is at least one `op` spawn or SDK IPC round
// trip (~1s under desktop-app auth; a bare ref pays a per-vault item listing
// on top). Successful resolutions are therefore served from memory for a
// short TTL. The cache is keyed by (config fingerprint, ref): editing or
// removing an account changes the fingerprint, which drops the whole cached
// generation immediately — a removed account's secrets never outlive the
// config that granted them, and no explicit invalidation wiring is needed.
// Only `kind: "resolved"` entries get the TTL; not-found, ambiguity, and
// failures are never retained, so a just-created item resolves on the next
// call. Concurrent lookups for the same key share one backend read even when
// the TTL is 0.
// ---------------------------------------------------------------------------

export type CachedRefResolver = (
  config: OnePasswordConfig,
  ref: string,
) => Effect.Effect<RefResolution, OnePasswordError>;

export const makeCachedRefResolver = (
  serviceFor: ServiceForAccount,
  ttlMs: number,
): CachedRefResolver => {
  // Single generation: config edits are rare and refs from an older config
  // must not be served, so the previous generation's cache is discarded
  // rather than kept alongside.
  let generation: {
    readonly fingerprint: string;
    readonly cache: Cache.Cache<string, RefResolution, OnePasswordError>;
  } | null = null;

  return (config, ref) =>
    Effect.suspend(() => {
      const fingerprint = JSON.stringify(config.accounts);
      if (generation === null || generation.fingerprint !== fingerprint) {
        generation = {
          fingerprint,
          cache: Effect.runSync(
            Cache.makeWith((key: string) => resolveConfiguredRef(config, serviceFor, key), {
              capacity: SECRET_CACHE_CAPACITY,
              timeToLive: (exit) =>
                Exit.isSuccess(exit) && exit.value.kind === "resolved"
                  ? Duration.millis(ttlMs)
                  : Duration.zero,
            }),
          ),
        };
      }
      return Cache.get(generation.cache, ref);
    });
};

// ---------------------------------------------------------------------------
// CredentialProvider — read-only, resolves op:// URIs or vault-scoped lookups.
//
// v2: `get(id)` receives only an opaque `ProviderItemId` — no scope. The id is
// a vault-qualified `op://` ref (what `list()` hands out) or a bare item
// id/title that must locate exactly one item across every account's
// configured vaults. The plugin's stored config supplies the auth + vault
// bindings; the provider never writes (writable: false).
// ---------------------------------------------------------------------------

const makeProvider = (
  ctx: PluginCtx<OnePasswordStore>,
  serviceFor: ServiceForAccount,
  resolveRef: CachedRefResolver,
): CredentialProvider => {
  return {
    key: PROVIDER_KEY,
    writable: false,

    get: (id: ProviderItemId): Effect.Effect<string | null, StorageFailure> =>
      ctx.storage.getConfig().pipe(
        // An undecodable stored config reads as "not configured" here; the
        // settings surface reports the decode problem.
        Effect.catchTag("OnePasswordError", () => Effect.succeed(null)),
        Effect.flatMap((config) => {
          if (!config) return Effect.succeed(null as string | null);

          return resolveRef(config, id).pipe(
            // Backend unreachability degrades to "no value", matching the other
            // providers. Ambiguity does NOT: silently picking a vault (or
            // silently failing) hides a real conflict, so it surfaces as a
            // typed failure with the full explanation.
            Effect.catch(() => Effect.succeed({ kind: "not-found" } as RefResolution)),
            Effect.flatMap((resolution): Effect.Effect<string | null, StorageError> => {
              if (resolution.kind === "ambiguous") {
                return Effect.fail(
                  new StorageError({
                    message: ambiguityMessage(id, resolution.matches),
                    cause: undefined,
                  }),
                );
              }
              if (resolution.kind === "ambiguous-vault") {
                return Effect.fail(
                  new StorageError({
                    message: vaultAmbiguityMessage(resolution),
                    cause: undefined,
                  }),
                );
              }
              return Effect.succeed(resolution.kind === "resolved" ? resolution.value : null);
            }),
          );
        }),
      ),

    list: (): Effect.Effect<readonly ProviderEntry[], StorageFailure> =>
      ctx.storage.getConfig().pipe(
        Effect.flatMap((config) => {
          if (!config) return Effect.succeed([] as readonly ProviderEntry[]);
          const multipleAccounts = config.accounts.length > 1;
          return Effect.forEach(config.accounts, (account) =>
            serviceFor(account).pipe(
              Effect.flatMap((svc) =>
                Effect.forEach(account.vaults, (vault) =>
                  svc.listItems(vault.id).pipe(
                    Effect.map((items) =>
                      items.map(
                        // Vault-qualified ids: picking an entry permanently
                        // records which vault it came from, so identically-titled
                        // items in different vaults can never collide.
                        (item): ProviderEntry => ({
                          id: ProviderItemId.make(`op://${vault.id}/${item.id}`),
                          name: item.title,
                          group: multipleAccounts ? `${account.name} · ${vault.name}` : vault.name,
                        }),
                      ),
                    ),
                  ),
                ),
              ),
              Effect.map((groups) => groups.flat()),
              // One unreachable account must not hide the others' items.
              Effect.catch(() => Effect.succeed([] as readonly ProviderEntry[])),
            ),
          ).pipe(Effect.map((groups): readonly ProviderEntry[] => groups.flat()));
        }),
        Effect.catch(() => Effect.succeed([] as readonly ProviderEntry[])),
      ),
  };
};

// ---------------------------------------------------------------------------
// Owner resolution — config is a single shared 1Password binding. We persist
// it under the `user` partition when the executor is bound to a subject, else
// the shared `org` partition.
// ---------------------------------------------------------------------------

const ownerForCtx = (ctx: PluginCtx<OnePasswordStore>): Owner =>
  ctx.owner.subject === null ? "org" : "user";

const makeOnePasswordExtension = (
  ctx: PluginCtx<OnePasswordStore>,
  serviceForAuth: (auth: OnePasswordAuth) => Effect.Effect<OnePasswordService, OnePasswordError>,
) => {
  const serviceFor: ServiceForAccount = (account) => serviceForAuth(account.auth);

  const accountStatus = (account: OnePasswordAccount): Effect.Effect<AccountStatus, never> =>
    serviceFor(account).pipe(
      Effect.flatMap((svc) => svc.listVaults()),
      Effect.map((live) => {
        const liveById = new Map(live.map((v) => [v.id, v.title]));
        const missing = account.vaults.filter((vault) => !liveById.has(vault.id));
        return AccountStatus.make({
          id: account.id,
          name: account.name,
          connected: true,
          vaultNames: account.vaults.map((vault) => liveById.get(vault.id) ?? vault.name),
          ...(missing.length > 0
            ? {
                error: `Configured vaults not found: ${missing
                  .map((vault) => vault.name)
                  .join(", ")}`,
              }
            : {}),
        });
      }),
      Effect.catchTag("OnePasswordError", (error) =>
        Effect.succeed(
          AccountStatus.make({
            id: account.id,
            name: account.name,
            connected: false,
            // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed `message`
            error: error.message,
          }),
        ),
      ),
    );

  return {
    /** Add or replace one account. A payload without an id creates a new
     *  account; with an id it replaces the matching account in place. */
    configure: (
      upsert: OnePasswordAccountUpsert,
    ): Effect.Effect<{ readonly accountId: string }, StorageError | OnePasswordError> =>
      Effect.gen(function* () {
        const existing = yield* ctx.storage.getConfig().pipe(
          // An undecodable blob must not brick configuration: the next save
          // rewrites the whole config in the current shape.
          Effect.catchTag("OnePasswordError", () => Effect.succeed(null)),
        );
        const accountId = upsert.id ?? crypto.randomUUID();
        const account = OnePasswordAccount.make({
          id: accountId,
          name: upsert.name,
          auth: upsert.auth,
          vaults: upsert.vaults,
        });
        // Position-preserving upsert: an edit replaces the account in place,
        // a new account appends — the settings list never reshuffles.
        const current = existing === null ? [] : existing.accounts;
        const accounts = current.some((candidate) => candidate.id === accountId)
          ? current.map((candidate) => (candidate.id === accountId ? account : candidate))
          : [...current, account];
        const [first, ...rest] = accounts;
        yield* ctx.storage.saveConfig(
          { accounts: first === undefined ? [account] : [first, ...rest] },
          ownerForCtx(ctx),
        );
        return { accountId };
      }),

    getConfig: (): Effect.Effect<
      RedactedOnePasswordConfig | null,
      StorageError | OnePasswordError
    > =>
      ctx.storage.getConfig().pipe(Effect.map((config) => (config ? redactConfig(config) : null))),

    /** Remove one account by id, or the whole configuration when no id is
     *  given. Removing the last account deletes the blob. */
    removeConfig: (accountId?: string): Effect.Effect<void, StorageError | OnePasswordError> => {
      if (accountId === undefined) return ctx.storage.deleteConfig(ownerForCtx(ctx));
      return Effect.gen(function* () {
        const existing = yield* ctx.storage.getConfig();
        if (existing === null) return;
        const remaining = existing.accounts.filter((account) => account.id !== accountId);
        const [first, ...rest] = remaining;
        if (first === undefined) {
          yield* ctx.storage.deleteConfig(ownerForCtx(ctx));
          return;
        }
        yield* ctx.storage.saveConfig({ accounts: [first, ...rest] }, ownerForCtx(ctx));
      });
    },

    status: () =>
      Effect.gen(function* () {
        const config = yield* ctx.storage.getConfig();
        if (!config) {
          return ConnectionStatus.make({
            connected: false,
            accounts: [],
            error: "Not configured",
          });
        }
        const accounts = yield* Effect.forEach(config.accounts, accountStatus);
        const broken = accounts.filter((account) => !account.connected);
        return ConnectionStatus.make({
          connected: broken.length === 0,
          accounts,
          ...(broken.length > 0
            ? {
                error: `Unreachable accounts: ${broken.map((account) => account.name).join(", ")}`,
              }
            : {}),
        });
      }),

    listVaults: (auth: OnePasswordAuth) =>
      Effect.gen(function* () {
        const svc = yield* serviceForAuth(auth);
        const vaults = yield* svc.listVaults();
        return vaults
          .map((v) => Vault.make({ id: v.id, name: v.title }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),

    resolve: (uri: string) =>
      Effect.gen(function* () {
        const config = yield* ctx.storage.getConfig();
        if (!config) {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: "1Password is not configured",
          });
        }
        const resolution = yield* resolveConfiguredRef(config, serviceFor, uri);
        if (resolution.kind === "resolved") return resolution.value;
        if (resolution.kind === "outside-vaults") {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: "1Password secret URI is outside the configured vaults",
          });
        }
        if (resolution.kind === "ambiguous") {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: ambiguityMessage(uri, resolution.matches),
          });
        }
        if (resolution.kind === "ambiguous-vault") {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: vaultAmbiguityMessage(resolution),
          });
        }
        return yield* new OnePasswordError({
          operation: "resolve",
          message: `1Password item "${uri}" was not found in the configured vaults`,
        });
      }),
  };
};

export type OnePasswordExtension = ReturnType<typeof makeOnePasswordExtension>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OnePasswordPluginOptions {
  /** Request timeout in ms (default: 15000) */
  readonly timeoutMs?: number;
  /** Force use of the native SDK instead of the CLI (default: false) */
  readonly preferSdk?: boolean;
  /** How long a successfully resolved secret may be served from memory
   *  before 1Password is asked again (default: 60000). `0` disables reuse
   *  while still collapsing concurrent resolutions of the same ref onto one
   *  backend read. */
  readonly secretCacheTtlMs?: number;
}

export const onepasswordPlugin = definePlugin((options?: OnePasswordPluginOptions) => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const preferSdk = options?.preferSdk;
  const secretCacheTtlMs = options?.secretCacheTtlMs ?? DEFAULT_SECRET_CACHE_TTL_MS;

  // Shared across the extension and the credential provider so both reuse the
  // same per-account services (and the SDK backend's cached client). The
  // secret cache keys by config fingerprint, so sharing it across executors
  // built from this factory cannot cross owner partitions.
  const serviceForAuth = makeServiceForAuth(timeoutMs, preferSdk);
  const serviceFor: ServiceForAccount = (account) => serviceForAuth(account.auth);
  const resolveRef = makeCachedRefResolver(serviceFor, secretCacheTtlMs);

  return {
    id: "onepassword" as const,
    packageName: "@executor-js/plugin-onepassword",
    storage: ({ blobs }) => makeOnePasswordStore(blobs),

    extension: (ctx) => makeOnePasswordExtension(ctx, serviceForAuth),

    staticIntegrations: (self) => [
      {
        id: "onepassword",
        kind: "executor",
        name: "1Password",
        tools: [
          tool({
            name: "status",
            description:
              "Check whether the 1Password credential provider is configured and can reach each account's selected vaults. This returns status only, never secret values.",
            outputSchema: OnePasswordStatusOutputStd,
            execute: () => Effect.map(self.status(), ToolResult.ok),
          }),
          tool({
            name: "getConfig",
            description:
              "Read the current 1Password provider configuration. This returns account/vault metadata only; service-account token values are never returned.",
            outputSchema: OnePasswordGetConfigOutputStd,
            execute: () => Effect.map(self.getConfig(), (config) => ToolResult.ok({ config })),
          }),
          tool({
            name: "listVaults",
            description:
              "List available 1Password vaults before configuring the provider. For service-account auth, pass the service account token directly.",
            inputSchema: OnePasswordListVaultsInputStd,
            outputSchema: OnePasswordListVaultsOutputStd,
            execute: (input) =>
              Effect.map(self.listVaults(input), (vaults) => ToolResult.ok({ vaults })),
          }),
          tool({
            name: "configure",
            description:
              "Add or update a named 1Password account for the acting owner, each scoping one or more vaults. Use desktop-app auth for local biometric access, or service-account auth with the token. The token is stored in the plugin's owner-partitioned config and never surfaced again. Pass the account id to update an existing account; omit it to add a new one.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Configure a 1Password credential provider account",
            },
            inputSchema: OnePasswordConfigureInputStd,
            outputSchema: OnePasswordConfigureOutputStd,
            execute: (input) =>
              Effect.map(
                self.configure({
                  ...(input.id !== undefined ? { id: input.id } : {}),
                  name: input.name,
                  auth: input.auth,
                  vaults: input.vaults,
                }),
                ({ accountId }) => ToolResult.ok({ configured: true, accountId }),
              ),
          }),
          tool({
            name: "removeConfig",
            description:
              "Remove one 1Password account by id, or the whole provider configuration when no id is given. Secret resolution through the removed account stops until reconfigured.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Remove 1Password credential provider configuration",
            },
            inputSchema: OnePasswordRemoveConfigInputStd,
            outputSchema: OnePasswordRemoveConfigOutputStd,
            execute: (input) =>
              Effect.as(self.removeConfig(input.accountId), ToolResult.ok({ removed: true })),
          }),
        ],
      },
    ],

    credentialProviders: (ctx) => [makeProvider(ctx, serviceFor, resolveRef)],
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-onepassword/api`. Hosts
  // that want the HTTP surface import the plugin from there; SDK-only
  // consumers stay on this entry and avoid the server-only deps.
});
