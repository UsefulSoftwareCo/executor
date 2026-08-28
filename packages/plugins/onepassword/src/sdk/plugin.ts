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

// ---------------------------------------------------------------------------
// Explicit ref resolution.
//
// A ref is one of:
//   - `op://vault/item/field...` — fully qualified, resolved as-is.
//   - `op://vault/item`         — picker-shaped; the default credential field
//                                 is appended. This is the id shape `list()`
//                                 hands out, so every picked item permanently
//                                 records which vault it came from.
//   - a bare item id or title   — located by listing the configured vaults.
//                                 Exactly one match resolves; several matches
//                                 are an explicit ambiguity failure naming the
//                                 vaults — never a silent precedence pick.
// ---------------------------------------------------------------------------

export type RefResolution =
  | { readonly kind: "resolved"; readonly value: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "outside-vaults" }
  | {
      readonly kind: "ambiguous";
      readonly matches: readonly {
        readonly vaultId: string;
        readonly vaultName: string;
        readonly itemId: string;
        readonly itemTitle: string;
      }[];
    };

export const ambiguityMessage = (
  ref: string,
  matches: Extract<RefResolution, { kind: "ambiguous" }>["matches"],
): string =>
  [
    `1Password ref "${ref}" is ambiguous: it matches`,
    matches.map((m) => `"${m.itemTitle}" in vault "${m.vaultName}"`).join(", "),
    `. Use op://<vaultId>/<itemId> to pick one.`,
  ].join(" ");

const isConfiguredVaultSegment = (config: OnePasswordConfig, segment: string): boolean =>
  config.vaults.some((vault) => vault.id === segment || vault.name === segment);

/** Resolve a ref against the configured vaults. Backend failures stay on the
 *  error channel; every addressing outcome is an explicit `RefResolution`. */
export const resolveConfiguredRef = (
  svc: OnePasswordService,
  config: OnePasswordConfig,
  ref: string,
): Effect.Effect<RefResolution, OnePasswordError> => {
  if (ref.startsWith("op://")) {
    const segments = ref.slice("op://".length).split("/");
    const vaultSegment = segments[0];
    if (segments.length < 2 || vaultSegment === undefined || segments.includes("")) {
      return Effect.succeed({ kind: "not-found" });
    }
    if (!isConfiguredVaultSegment(config, vaultSegment)) {
      return Effect.succeed({ kind: "outside-vaults" });
    }
    const uri = segments.length === 2 ? `${ref}/${CREDENTIAL_FIELD}` : ref;
    return svc
      .resolveSecret(uri)
      .pipe(Effect.map((value): RefResolution => ({ kind: "resolved", value })));
  }

  return Effect.gen(function* () {
    const matches = (yield* Effect.forEach(config.vaults, (vault) =>
      svc.listItems(vault.id).pipe(
        Effect.map((items) =>
          items
            .filter((item) => item.id === ref || item.title === ref)
            .map((item) => ({
              vaultId: vault.id,
              vaultName: vault.name,
              itemId: item.id,
              itemTitle: item.title,
            })),
        ),
      ),
    )).flat();

    const [only, ...extra] = matches;
    if (only === undefined) return { kind: "not-found" } as const;
    if (extra.length > 0) return { kind: "ambiguous", matches } as const;

    const value = yield* svc.resolveSecret(
      `op://${only.vaultId}/${only.itemId}/${CREDENTIAL_FIELD}`,
    );
    return { kind: "resolved", value } as const;
  });
};

// ---------------------------------------------------------------------------
// CredentialProvider — read-only, resolves op:// URIs or vault-scoped lookups.
//
// v2: `get(id)` receives only an opaque `ProviderItemId` — no scope. The id is
// a vault-qualified `op://` ref (what `list()` hands out) or a bare item
// id/title that must locate exactly one item across the configured vaults.
// The plugin's stored config supplies the auth + vault bindings; the provider
// never writes (writable: false).
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
      // An undecodable stored config reads as "not configured" here; the
      // settings surface reports the decode problem.
      Effect.catchTag("OnePasswordError", () => Effect.succeed(null)),
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed(null as string | null);

        return getServiceFromConfig(config, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) => resolveConfiguredRef(svc, config, id)),
          // Backend unreachability degrades to "no value", matching the other
          // providers. Ambiguity does NOT: silently picking a vault (or
          // silently failing) hides a real conflict, so it surfaces as a
          // typed failure with the full explanation.
          Effect.catch(() => Effect.succeed({ kind: "not-found" } as RefResolution)),
          Effect.flatMap(
            (resolution): Effect.Effect<string | null, StorageError> =>
              resolution.kind === "ambiguous"
                ? Effect.fail(
                    new StorageError({
                      message: ambiguityMessage(id, resolution.matches),
                      cause: undefined,
                    }),
                  )
                : Effect.succeed(resolution.kind === "resolved" ? resolution.value : null),
          ),
        );
      }),
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
                    // Vault-qualified ids: picking an entry permanently
                    // records which vault it came from, so identically-titled
                    // items in different vaults can never collide.
                    (item): ProviderEntry => ({
                      id: ProviderItemId.make(`op://${vault.id}/${item.id}`),
                      name: item.title,
                      group: vault.name,
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
        const svc = yield* getServiceFromConfig(config, timeoutMs, preferSdk);
        const resolution = yield* resolveConfiguredRef(svc, config, uri);
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
