import { Effect, Schema } from "effect";

import {
  definePlugin,
  StorageError,
  type PluginCtx,
  type PluginBlobStore,
  type SecretProvider,
  type StorageFailure,
} from "@executor-js/sdk/core";

import { OnePasswordGroup } from "../api/group";
import { OnePasswordExtensionService, OnePasswordHandlers } from "../api/handlers";

import { OnePasswordConfig, Vault, ConnectionStatus } from "./types";
import type { OnePasswordAuth } from "./types";
import { OnePasswordError } from "./errors";
import { makeOnePasswordService, type ResolvedAuth, type OnePasswordService } from "./service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIAL_FIELD = "credential";
const DEFAULT_TIMEOUT_MS = 15_000;
const CONFIG_KEY = "config";

// ---------------------------------------------------------------------------
// Shared failure alias.
//
// Every extension method either touches storage (`ctx.storage` blobs or
// `ctx.secrets`) or reaches the 1Password backend. Storage I/O surfaces
// as `StorageFailure`; the HTTP edge (`withCapture`) translates
// `StorageError` to `InternalError({ traceId })`. Domain problems (not
// configured, service-account token missing, backend RPC failure) stay
// as `OnePasswordError` and encode to 502 via the schema annotation on
// the class.
// ---------------------------------------------------------------------------

export type OnePasswordExtensionFailure = OnePasswordError | StorageFailure;

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.onepassword
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Typed config store — single blob, JSON encoded. Blob I/O failures surface
// as `StorageError` (HTTP edge translates to `InternalError`); decode
// failures stay `OnePasswordError` — the blob's contents are a plugin
// concern, not an infrastructure one.
// ---------------------------------------------------------------------------

export interface OnePasswordStore {
  readonly getConfig: () => Effect.Effect<
    OnePasswordConfig | null,
    StorageError | OnePasswordError
  >;
  readonly saveConfig: (
    config: OnePasswordConfig,
    targetScope: string,
  ) => Effect.Effect<void, StorageError>;
  readonly deleteConfig: (targetScope: string) => Effect.Effect<void, StorageError>;
}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(OnePasswordConfig));

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

  saveConfig: (config, targetScope) =>
    blobs
      .put(
        CONFIG_KEY,
        JSON.stringify({
          auth: config.auth,
          vaultId: config.vaultId,
          name: config.name,
        }),
        { scope: targetScope },
      )
      .pipe(Effect.mapError(blobStorageError("write"))),

  deleteConfig: (targetScope) =>
    blobs
      .delete(CONFIG_KEY, { scope: targetScope })
      .pipe(Effect.mapError(blobStorageError("delete"))),
});

// ---------------------------------------------------------------------------
// Helpers — auth resolution + service construction
// ---------------------------------------------------------------------------

const resolveAuth = (
  auth: OnePasswordAuth,
  ctx: PluginCtx<OnePasswordStore>,
): Effect.Effect<ResolvedAuth, OnePasswordError | StorageFailure> => {
  if (auth.kind === "desktop-app") {
    return Effect.succeed({
      kind: "desktop-app" as const,
      accountName: auth.accountName,
    });
  }
  return ctx.secrets.get(auth.tokenSecretId).pipe(
    Effect.catchTag("SecretOwnedByConnectionError", () =>
      Effect.fail(
        new OnePasswordError({
          operation: "auth resolution",
          message: `Service account token secret "${auth.tokenSecretId}" not found`,
        }),
      ),
    ),
    Effect.flatMap((token) => {
      if (token === null) {
        return Effect.fail(
          new OnePasswordError({
            operation: "auth resolution",
            message: `Service account token secret "${auth.tokenSecretId}" not found`,
          }),
        );
      }
      return Effect.succeed({
        kind: "service-account" as const,
        token,
      });
    }),
  );
};

const getServiceFromConfig = (
  config: OnePasswordConfig,
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): Effect.Effect<OnePasswordService, OnePasswordError | StorageFailure> =>
  resolveAuth(config.auth, ctx).pipe(
    Effect.flatMap((resolved) => makeOnePasswordService(resolved, { timeoutMs, preferSdk })),
  );

const configuredVaultUri = (config: OnePasswordConfig, secretId: string): string | null => {
  if (!secretId.startsWith("op://")) {
    return `op://${config.vaultId}/${secretId}/${CREDENTIAL_FIELD}`;
  }
  const match = secretId.match(/^op:\/\/([^/]+)\/.+/);
  if (!match || match[1] !== config.vaultId) return null;
  return secretId;
};

// ---------------------------------------------------------------------------
// SecretProvider — read-only, resolves op:// URIs or vaultId-based lookups
// ---------------------------------------------------------------------------

const makeProvider = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): SecretProvider => ({
  key: "onepassword",
  writable: false,
  allowFallback: false,

  // 1Password vaults are named in the stored config; the executor-scope
  // arg isn't used for routing here. A future refactor could let the
  // plugin store per-scope vault bindings and pick based on `scope`.
  get: (secretId, _scope) =>
    ctx.storage.getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed(null as string | null);

        const uri = configuredVaultUri(config, secretId);
        if (uri === null) return Effect.succeed(null as string | null);

        return getServiceFromConfig(config, ctx, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) => svc.resolveSecret(uri)),
          Effect.map((v): string | null => v),
          Effect.orElseSucceed(() => null),
        );
      }),
      Effect.orElseSucceed(() => null),
    ),

  list: () =>
    ctx.storage.getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed([] as ReadonlyArray<{ id: string; name: string }>);
        return getServiceFromConfig(config, ctx, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) => svc.listItems(config.vaultId)),
          Effect.map(
            (items): ReadonlyArray<{ id: string; name: string }> =>
              items.map((item) => ({ id: item.id, name: item.title })),
          ),
        );
      }),
      Effect.orElseSucceed(() => [] as ReadonlyArray<{ id: string; name: string }>),
    ),
});

const makeOnePasswordExtension = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
) => {
  return {
    configure: (config: OnePasswordConfig, targetScope: string) =>
      ctx.storage.saveConfig(config, targetScope),

    getConfig: () => ctx.storage.getConfig(),

    removeConfig: (targetScope: string) => ctx.storage.deleteConfig(targetScope),

    status: () =>
      Effect.gen(function* () {
        const config = yield* ctx.storage.getConfig();
        if (!config) {
          return new ConnectionStatus({
            connected: false,
            error: "Not configured",
          });
        }
        const svc = yield* getServiceFromConfig(config, ctx, timeoutMs, preferSdk);
        const vaults = yield* svc.listVaults();
        const vault = vaults.find((v) => v.id === config.vaultId);
        return new ConnectionStatus({
          connected: true,
          vaultName: vault?.title,
        });
      }),

    listVaults: (auth: OnePasswordAuth) =>
      Effect.gen(function* () {
        const resolved = yield* resolveAuth(auth, ctx);
        const svc = yield* makeOnePasswordService(resolved, {
          timeoutMs,
          preferSdk,
        });
        const vaults = yield* svc.listVaults();
        return vaults
          .map((v) => new Vault({ id: v.id, name: v.title }))
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
        const scopedUri = configuredVaultUri(config, uri);
        if (scopedUri === null) {
          return yield* new OnePasswordError({
            operation: "resolve",
            message: "1Password secret URI is outside the configured vault",
          });
        }
        const svc = yield* getServiceFromConfig(config, ctx, timeoutMs, preferSdk);
        return yield* svc.resolveSecret(scopedUri);
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

    secretProviders: (ctx) => [makeProvider(ctx, timeoutMs, preferSdk)],

    routes: () => OnePasswordGroup,
    handlers: () => OnePasswordHandlers,
    extensionService: OnePasswordExtensionService,
  };
});
