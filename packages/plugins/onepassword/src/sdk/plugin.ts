import { Effect, Schema } from "effect";

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
  OnePasswordAuth,
  OnePasswordConfig,
  RedactedOnePasswordConfig,
  StoredOnePasswordConfig,
  Vault,
  ConnectionStatus,
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
const CONFIG_KEY = "config";
const PROVIDER_KEY = ProviderKey.make("onepassword");

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const OnePasswordConfigureInput = OnePasswordConfig;

const OnePasswordConfigureOutput = Schema.Struct({
  configured: Schema.Boolean,
});

const OnePasswordGetConfigOutput = Schema.Struct({
  config: Schema.NullOr(RedactedOnePasswordConfig),
});

const OnePasswordListVaultsInput = OnePasswordAuth;

const OnePasswordListVaultsOutput = Schema.Struct({
  vaults: Schema.Array(Vault),
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
// stored config carries the auth credential (desktop account name, or
// service-account token) plus the selected vaults. v1 keyed this by executor
// scope; v2 partitions by `owner` — the plugin-owned config row owns the
// partition, mirroring the connection model. Reads also accept the legacy
// single-`vaultId` shape and normalize it to the vaults array; saves always
// write the current shape. Blob I/O failures surface as `StorageError`;
// decode failures stay `OnePasswordError`.
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
      .put(
        CONFIG_KEY,
        JSON.stringify({
          auth: config.auth,
          vaults: config.vaults,
          name: config.name,
        }),
        { owner },
      )
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

const getServiceFromConfig = (
  config: OnePasswordConfig,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  makeOnePasswordService(resolveAuth(config.auth), { timeoutMs, preferSdk });

/** Candidate `op://` URIs for an item id, in resolution order.
 *
 * A bare item id fans out to one candidate per configured vault (item ids are
 * unique across an account, so at most one resolves). A fully-qualified
 * `op://` URI is a single candidate when its vault segment names a configured
 * vault (by id or by name — 1Password accepts either), and no candidate at
 * all when it points outside the configured set. */
export const candidateSecretUris = (
  config: OnePasswordConfig,
  itemId: string,
): readonly string[] => {
  if (!itemId.startsWith("op://")) {
    return config.vaults.map((vault) => `op://${vault.id}/${itemId}/${CREDENTIAL_FIELD}`);
  }
  const match = itemId.match(/^op:\/\/([^/]+)\/.+/);
  if (!match) return [];
  const segment = match[1];
  return config.vaults.some((vault) => vault.id === segment || vault.name === segment)
    ? [itemId]
    : [];
};

/** Try candidates in order; the first successful resolution wins. Fails with
 *  the last backend error when every candidate fails. */
const resolveFirstCandidate = (
  svc: OnePasswordService,
  first: string,
  rest: readonly string[],
): Effect.Effect<string, OnePasswordError> =>
  rest.reduce(
    (acc, uri) => acc.pipe(Effect.catch(() => svc.resolveSecret(uri))),
    svc.resolveSecret(first),
  );

// ---------------------------------------------------------------------------
// CredentialProvider — read-only, resolves op:// URIs or vault-scoped lookups.
//
// v2: `get(id)` receives only an opaque `ProviderItemId` — no scope. The id is
// either a fully-qualified `op://vault/item/field` URI or a bare item id that
// is looked up across the configured vaults in order. The plugin's stored
// config supplies the auth + vault bindings; the provider never writes
// (writable: false).
// ---------------------------------------------------------------------------

const makeProvider = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): CredentialProvider => ({
  key: PROVIDER_KEY,
  writable: false,

  get: (id: ProviderItemId): Effect.Effect<string | null, StorageFailure> =>
    ctx.storage.getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed(null as string | null);

        const [first, ...rest] = candidateSecretUris(config, id);
        if (first === undefined) return Effect.succeed(null as string | null);

        return getServiceFromConfig(config, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) => resolveFirstCandidate(svc, first, rest)),
          Effect.map((v): string | null => v),
          Effect.orElseSucceed(() => null),
        );
      }),
      Effect.catch(() => Effect.succeed(null as string | null)),
    ),

  list: (): Effect.Effect<readonly ProviderEntry[], StorageFailure> =>
    ctx.storage.getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed([] as readonly ProviderEntry[]);
        return getServiceFromConfig(config, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) =>
            Effect.forEach(config.vaults, (vault) =>
              svc.listItems(vault.id).pipe(
                Effect.map((items) =>
                  items.map(
                    (item): ProviderEntry => ({
                      id: ProviderItemId.make(item.id),
                      // With several vaults the vault name disambiguates
                      // identically-titled items in pickers.
                      name: config.vaults.length > 1 ? `${item.title} (${vault.name})` : item.title,
                    }),
                  ),
                ),
              ),
            ),
          ),
          Effect.map((groups): readonly ProviderEntry[] => groups.flat()),
        );
      }),
      Effect.catch(() => Effect.succeed([] as readonly ProviderEntry[])),
    ),
});

// ---------------------------------------------------------------------------
// Owner resolution — config is a single shared 1Password binding. We persist
// it under the `user` partition when the executor is bound to a subject, else
// the shared `org` partition.
// ---------------------------------------------------------------------------

const ownerForCtx = (ctx: PluginCtx<OnePasswordStore>): Owner =>
  ctx.owner.subject === null ? "org" : "user";

const makeOnePasswordExtension = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
) => {
  return {
    configure: (config: OnePasswordConfig) => ctx.storage.saveConfig(config, ownerForCtx(ctx)),

    getConfig: (): Effect.Effect<
      RedactedOnePasswordConfig | null,
      StorageError | OnePasswordError
    > =>
      ctx.storage.getConfig().pipe(Effect.map((config) => (config ? redactConfig(config) : null))),

    removeConfig: () => ctx.storage.deleteConfig(ownerForCtx(ctx)),

    status: () =>
      Effect.gen(function* () {
        const config = yield* ctx.storage.getConfig();
        if (!config) {
          return ConnectionStatus.make({
            connected: false,
            error: "Not configured",
          });
        }
        const svc = yield* getServiceFromConfig(config, timeoutMs, preferSdk);
        const live = yield* svc.listVaults();
        const liveById = new Map(live.map((v) => [v.id, v.title]));
        const missing = config.vaults.filter((vault) => !liveById.has(vault.id));
        return ConnectionStatus.make({
          connected: true,
          vaultNames: config.vaults.map((vault) => liveById.get(vault.id) ?? vault.name),
          ...(missing.length > 0
            ? {
                error: `Configured vaults not found: ${missing
                  .map((vault) => vault.name)
                  .join(", ")}`,
              }
            : {}),
        });
      }),

    listVaults: (auth: OnePasswordAuth) =>
      Effect.gen(function* () {
        const svc = yield* makeOnePasswordService(resolveAuth(auth), {
          timeoutMs,
          preferSdk,
        });
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
        const [first, ...rest] = candidateSecretUris(config, uri);
        if (first === undefined) {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: "1Password secret URI is outside the configured vaults",
          });
        }
        const svc = yield* getServiceFromConfig(config, timeoutMs, preferSdk);
        return yield* resolveFirstCandidate(svc, first, rest);
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
}

export const onepasswordPlugin = definePlugin((options?: OnePasswordPluginOptions) => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const preferSdk = options?.preferSdk;

  return {
    id: "onepassword" as const,
    packageName: "@executor-js/plugin-onepassword",
    storage: ({ blobs }) => makeOnePasswordStore(blobs),

    extension: (ctx) => makeOnePasswordExtension(ctx, timeoutMs, preferSdk),

    staticIntegrations: (self) => [
      {
        id: "onepassword",
        kind: "executor",
        name: "1Password",
        tools: [
          tool({
            name: "status",
            description:
              "Check whether the 1Password credential provider is configured and can reach its selected vaults. This returns status only, never secret values.",
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
              "Configure the 1Password credential provider for the acting owner with one or more vaults. Use desktop-app auth for local biometric access, or service-account auth with the token. The token is stored in the plugin's owner-partitioned config and never surfaced again.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Configure the 1Password credential provider",
            },
            inputSchema: OnePasswordConfigureInputStd,
            outputSchema: OnePasswordConfigureOutputStd,
            execute: (input) =>
              Effect.as(
                self.configure({ auth: input.auth, vaults: input.vaults, name: input.name }),
                ToolResult.ok({ configured: true }),
              ),
          }),
          tool({
            name: "removeConfig",
            description:
              "Remove the 1Password provider configuration for the acting owner. Future 1Password secret resolution stops until reconfigured.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Remove the 1Password credential provider configuration",
            },
            outputSchema: OnePasswordRemoveConfigOutputStd,
            execute: () => Effect.as(self.removeConfig(), ToolResult.ok({ removed: true })),
          }),
        ],
      },
    ],

    credentialProviders: (ctx) => [makeProvider(ctx, timeoutMs, preferSdk)],
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-onepassword/api`. Hosts
  // that want the HTTP surface import the plugin from there; SDK-only
  // consumers stay on this entry and avoid the server-only deps.
});
