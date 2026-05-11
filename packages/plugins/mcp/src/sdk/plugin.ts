import {
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Scope,
  ScopedCache,
} from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import { McpGroup } from "../api/group";
import { McpExtensionService, McpHandlers } from "../api/handlers";

import {
  ConfiguredCredentialBinding,
  ConnectionId,
  type CredentialBindingRef,
  ScopeId,
  SecretId,
  SourceDetectionResult,
  definePlugin,
  resolveSecretBackedMap as resolveSharedSecretBackedMap,
  type PluginCtx,
  type StorageFailure,
  StorageError,
  type ToolAnnotations,
} from "@executor-js/sdk/core";

import {
  makeMcpStore,
  mcpSchema,
  type McpBindingStore,
  type McpStoredSource,
} from "./binding-store";
import { createMcpConnector, type ConnectorInput, type McpConnection } from "./connection";
import { discoverTools } from "./discover";
import { McpConnectionError, McpInvocationError, McpToolDiscoveryError } from "./errors";
import { invokeMcpTool } from "./invoke";
import { deriveMcpNamespace, type McpToolManifest, type McpToolManifestEntry } from "./manifest";
import { probeMcpEndpointShape, type McpShapeProbeResult } from "./probe-shape";
import {
  MCP_HEADER_AUTH_SLOT,
  MCP_OAUTH_CLIENT_ID_SLOT,
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  MCP_OAUTH_CONNECTION_SLOT,
  McpToolBinding,
  McpSourceBindingInput,
  McpSourceBindingRef,
  mcpHeaderSlot,
  mcpQueryParamSlot,
  type McpConnectionAuth,
  type McpConnectionAuthInput,
  type McpCredentialInput,
  type McpSourceBindingValue,
  type SecretBackedValue,
  type McpStoredSourceData,
  type ConfiguredMcpCredentialValue,
} from "./types";

import {
  SECRET_REF_PREFIX,
  type ConfigFileSink,
  type McpAuthConfig,
  type McpRemoteSourceConfig as McpRemoteConfigEntry,
  type McpStdioSourceConfig as McpStdioConfigEntry,
  type SourceConfig,
} from "@executor-js/config";

// ---------------------------------------------------------------------------
// Plugin config — discriminated union on transport
// ---------------------------------------------------------------------------

/**
 * Executor scope id that owns a newly-added MCP source row. Must be one
 * of the executor's configured scopes. Admins adding a shared server at
 * org scope pin here; per-user stdio sources can pin at the inner
 * scope.
 */
type McpSourceScopeField = { readonly scope: string };

export interface McpRemoteSourceConfig extends McpSourceScopeField {
  readonly transport: "remote";
  readonly name: string;
  readonly endpoint: string;
  readonly remoteTransport?: "streamable-http" | "sse" | "auto";
  readonly queryParams?: Record<string, McpCredentialInput>;
  readonly headers?: Record<string, McpCredentialInput>;
  readonly namespace?: string;
  readonly auth?: McpConnectionAuthInput;
  /**
   * Scope that owns any direct credentials supplied on this call. Required
   * whenever headers/queryParams/auth carry direct secret or connection ids.
   */
  readonly credentialTargetScope?: string;
}

export interface McpStdioSourceConfig extends McpSourceScopeField {
  readonly transport: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly namespace?: string;
}

export type McpSourceConfig = McpRemoteSourceConfig | McpStdioSourceConfig;

// ---------------------------------------------------------------------------
// Extension types
// ---------------------------------------------------------------------------

// OAuth start/complete/callback moved to the shared
// `/scopes/:scopeId/oauth/*` surface in `@executor-js/api` — no
// plugin-specific types needed here.

export interface McpProbeResult {
  readonly connected: boolean;
  readonly requiresOAuth: boolean;
  readonly supportsDynamicRegistration: boolean;
  readonly name: string;
  readonly namespace: string;
  readonly toolCount: number | null;
  readonly serverName: string | null;
}

export interface McpUpdateSourceInput {
  readonly name?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, McpCredentialInput>;
  readonly queryParams?: Record<string, McpCredentialInput>;
  readonly credentialTargetScope?: string;
  readonly auth?: McpConnectionAuthInput;
}

export interface McpProbeEndpointInput {
  readonly endpoint: string;
  readonly headers?: Record<string, SecretBackedValue>;
  readonly queryParams?: Record<string, SecretBackedValue>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toStoredSourceData = (
  config: McpSourceConfig,
  remoteCredentials?: {
    readonly headers: Record<string, ConfiguredMcpCredentialValue>;
    readonly queryParams: Record<string, ConfiguredMcpCredentialValue>;
    readonly auth: McpConnectionAuth;
  },
): McpStoredSourceData => {
  if (config.transport === "stdio") {
    return {
      transport: "stdio",
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    };
  }
  return {
    transport: "remote",
    endpoint: config.endpoint,
    remoteTransport: config.remoteTransport ?? "auto",
    queryParams: remoteCredentials?.queryParams,
    headers: remoteCredentials?.headers,
    auth: remoteCredentials?.auth ?? { kind: "none" },
  };
};

const normalizeNamespace = (config: McpSourceConfig): string =>
  config.namespace ??
  deriveMcpNamespace({
    name: config.name,
    endpoint: config.transport === "remote" ? config.endpoint : undefined,
    command: config.transport === "stdio" ? config.command : undefined,
  });

const toBinding = (entry: McpToolManifestEntry): McpToolBinding =>
  new McpToolBinding({
    toolId: entry.toolId,
    toolName: entry.toolName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    annotations: entry.annotations,
  });

const MCP_PLUGIN_ID = "mcp";

/** Match `token` as a separator-bounded run inside a URL hostname or path,
 *  used as a low-confidence detection hint when wire-shape detection fails.
 *  Boundary chars are everything non-alphanumeric, so `/api/mcp`,
 *  `mcp.example.com`, `mcp-server`, and `mcp_v1` all match while
 *  `mcphost.com` and `/mcpstore` do not. */
const urlMatchesToken = (url: URL, token: string): boolean => {
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i");
  return re.test(url.hostname) || re.test(url.pathname);
};

/** Translate a non-MCP probe outcome into a message a user can act on.
 *  The technical `reason` (`401 without Bearer WWW-Authenticate — not an
 *  MCP auth challenge`, etc.) stays in telemetry via the probe span; the
 *  user gets a sentence pointing at their next step. Exported for tests. */
export const userFacingProbeMessage = (
  shape: Extract<McpShapeProbeResult, { kind: "not-mcp" } | { kind: "unreachable" }>,
): string => {
  if (shape.kind === "unreachable") {
    return "Couldn't reach this URL. Check the address, your network, and that the server is running.";
  }
  switch (shape.category) {
    case "auth-required":
      return "This server requires authentication. Add credentials (Authorization header, query parameter, or API key) below and retry.";
    case "wrong-shape":
      return "This URL doesn't appear to host an MCP server. Double-check the address, including the path.";
  }
};

const scopeRanks = (ctx: PluginCtx<McpBindingStore>): ReadonlyMap<string, number> =>
  new Map(ctx.scopes.map((scope, index) => [String(scope.id), index]));

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: string): number =>
  ranks.get(scopeId) ?? Infinity;

const coreBindingToMcpBinding = (binding: CredentialBindingRef): McpSourceBindingRef =>
  new McpSourceBindingRef({
    sourceId: binding.sourceId,
    sourceScopeId: binding.sourceScopeId,
    scopeId: binding.scopeId,
    slot: binding.slotKey,
    value: binding.value,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  });

const listMcpSourceBindings = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
): Effect.Effect<readonly McpSourceBindingRef[], StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, sourceScope);
    if (sourceSourceRank === Infinity) return [];
    const bindings = yield* ctx.credentialBindings.listForSource({
      pluginId: MCP_PLUGIN_ID,
      sourceId,
      sourceScope: ScopeId.make(sourceScope),
    });
    return bindings
      .filter((binding) => scopeRank(ranks, binding.scopeId) <= sourceSourceRank)
      .map(coreBindingToMcpBinding);
  });

const resolveMcpSourceBinding = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  slot: string,
): Effect.Effect<McpSourceBindingRef | null, StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, sourceScope);
    if (sourceSourceRank === Infinity) return null;
    const bindings = yield* ctx.credentialBindings.listForSource({
      pluginId: MCP_PLUGIN_ID,
      sourceId,
      sourceScope: ScopeId.make(sourceScope),
    });
    const binding = bindings
      .filter(
        (candidate) =>
          candidate.slotKey === slot && scopeRank(ranks, candidate.scopeId) <= sourceSourceRank,
      )
      .sort((a, b) => scopeRank(ranks, a.scopeId) - scopeRank(ranks, b.scopeId))[0];
    return binding ? coreBindingToMcpBinding(binding) : null;
  });

const validateMcpBindingTarget = (
  ctx: PluginCtx<McpBindingStore>,
  input: {
    readonly sourceScope: string;
    readonly targetScope: string;
    readonly sourceId: string;
  },
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    const ranks = scopeRanks(ctx);
    const sourceSourceRank = scopeRank(ranks, input.sourceScope);
    const targetRank = scopeRank(ranks, input.targetScope);
    const scopeList = `[${ctx.scopes.map((s) => s.id).join(", ")}]`;
    if (sourceSourceRank === Infinity) {
      return yield* new StorageError({
        message:
          `MCP source binding references source scope "${input.sourceScope}" ` +
          `which is not in the executor's scope stack ${scopeList}.`,
        cause: undefined,
      });
    }
    if (targetRank === Infinity) {
      return yield* new StorageError({
        message:
          `MCP source binding targets scope "${input.targetScope}" which is not ` +
          `in the executor's scope stack ${scopeList}.`,
        cause: undefined,
      });
    }
    if (targetRank > sourceSourceRank) {
      return yield* new StorageError({
        message:
          `MCP source bindings for "${input.sourceId}" cannot be written at ` +
          `outer scope "${input.targetScope}" because the base source lives at ` +
          `"${input.sourceScope}"`,
        cause: undefined,
      });
    }
  });

const bindingTargetScope = (
  targetScope: string | undefined,
  bindings: readonly unknown[],
): Effect.Effect<string | undefined, McpConnectionError> => {
  if (bindings.length === 0) return Effect.succeed(undefined);
  if (targetScope) return Effect.succeed(targetScope);
  return Effect.fail(
    new McpConnectionError({
      transport: "remote",
      message: "credentialTargetScope is required when adding direct MCP credentials",
    }),
  );
};

const targetScopeForBinding = (
  fallbackTargetScope: string | undefined,
  binding: { readonly targetScope?: string },
): Effect.Effect<string, McpConnectionError> => {
  const targetScope = binding.targetScope ?? fallbackTargetScope;
  if (targetScope) return Effect.succeed(targetScope);
  return Effect.fail(
    new McpConnectionError({
      transport: "remote",
      message: "credentialTargetScope is required when adding direct MCP credentials",
    }),
  );
};

const canonicalizeCredentialMap = (
  values: Record<string, McpCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredMcpCredentialValue>;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: McpSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  const nextValues: Record<string, ConfiguredMcpCredentialValue> = {};
  const bindings: Array<{ slot: string; value: McpSourceBindingValue; targetScope?: string }> = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      nextValues[name] = value;
      continue;
    }
    if ("kind" in value) {
      nextValues[name] = value;
      continue;
    }
    const slot = slotForName(name);
    nextValues[name] = new ConfiguredCredentialBinding({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
    bindings.push({
      slot,
      targetScope: "targetScope" in value ? value.targetScope : undefined,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
        ...("secretScopeId" in value && value.secretScopeId
          ? { secretScopeId: value.secretScopeId }
          : {}),
      },
    });
  }
  return { values: nextValues, bindings };
};

const canonicalizeAuth = (
  auth: McpConnectionAuthInput | undefined,
): {
  readonly auth: McpConnectionAuth;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: McpSourceBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  if (!auth || auth.kind === "none") return { auth: { kind: "none" }, bindings: [] };
  if (auth.kind === "header") {
    if ("secretSlot" in auth) return { auth, bindings: [] };
    return {
      auth: {
        kind: "header",
        headerName: auth.headerName,
        secretSlot: MCP_HEADER_AUTH_SLOT,
        prefix: auth.prefix,
      },
      bindings: [
        {
          slot: MCP_HEADER_AUTH_SLOT,
          targetScope: auth.targetScope,
          value: {
            kind: "secret",
            secretId: SecretId.make(auth.secretId),
            ...(auth.secretScopeId ? { secretScopeId: auth.secretScopeId } : {}),
          },
        },
      ],
    };
  }
  if ("connectionSlot" in auth) return { auth, bindings: [] };
  const bindings: Array<{ slot: string; value: McpSourceBindingValue; targetScope?: string }> = [
    {
      slot: MCP_OAUTH_CONNECTION_SLOT,
      value: {
        kind: "connection",
        connectionId: ConnectionId.make(auth.connectionId),
      },
    },
  ];
  if (auth.clientIdSecretId) {
    bindings.push({
      slot: MCP_OAUTH_CLIENT_ID_SLOT,
      value: { kind: "secret", secretId: SecretId.make(auth.clientIdSecretId) },
    });
  }
  if (auth.clientSecretSecretId) {
    bindings.push({
      slot: MCP_OAUTH_CLIENT_SECRET_SLOT,
      value: { kind: "secret", secretId: SecretId.make(auth.clientSecretSecretId) },
    });
  }
  return {
    auth: {
      kind: "oauth2",
      connectionSlot: MCP_OAUTH_CONNECTION_SLOT,
      ...(auth.clientIdSecretId ? { clientIdSlot: MCP_OAUTH_CLIENT_ID_SLOT } : {}),
      ...(auth.clientSecretSecretId ? { clientSecretSlot: MCP_OAUTH_CLIENT_SECRET_SLOT } : {}),
    },
    bindings,
  };
};

// ---------------------------------------------------------------------------
// MCP-SDK OAuth provider adapter — builds the `OAuthClientProvider` the
// MCP SDK's StreamableHTTP/SSE transports want, wrapping a pre-resolved
// access token.
//
// Refresh is NOT driven through this provider — `ctx.connections.access
// Token` owns that lifecycle at the core level via the canonical
// "oauth2" ConnectionProvider. This adapter only injects the current
// token into the transport's Authorization header and fails loudly if
// the SDK ever tries to initiate a new OAuth flow (which would bypass
// our refresh machinery).
// ---------------------------------------------------------------------------
const makeOAuthProvider = (accessToken: string): OAuthClientProvider => ({
  get redirectUrl() {
    return "http://localhost/oauth/callback";
  },
  get clientMetadata() {
    return {
      redirect_uris: ["http://localhost/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"] as string[],
      response_types: ["code"] as string[],
      token_endpoint_auth_method: "none" as const,
      client_name: "Executor",
    };
  },
  clientInformation: () => undefined,
  saveClientInformation: () => undefined,
  tokens: () => ({ access_token: accessToken, token_type: "Bearer" }),
  saveTokens: () => undefined,
  redirectToAuthorization: async () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: MCP SDK OAuthClientProvider callback can only signal reauthorization by throwing
    throw new Error("MCP OAuth re-authorization required");
  },
  saveCodeVerifier: () => undefined,
  codeVerifier: () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: MCP SDK OAuthClientProvider callback requires a thrown verifier failure
    throw new Error("No active PKCE verifier");
  },
  saveDiscoveryState: () => undefined,
  discoveryState: () => undefined,
});

const resolveSecretBackedMap = (
  values: Record<string, SecretBackedValue> | undefined,
  ctx: PluginCtx<McpBindingStore>,
): Effect.Effect<Record<string, string> | undefined, McpConnectionError | StorageFailure> =>
  resolveSharedSecretBackedMap({
    values,
    getSecret: ctx.secrets.get,
    onMissing: (_name, value) =>
      new McpConnectionError({
        transport: "remote",
        message: `Failed to resolve secret "${value.secretId}"`,
      }),
    onError: (err, _name, value) =>
      Predicate.isTagged("SecretOwnedByConnectionError")(err)
        ? new McpConnectionError({
            transport: "remote",
            message: `Failed to resolve secret "${value.secretId}"`,
          })
        : err,
  }).pipe(
    Effect.mapError((err) =>
      Predicate.isTagged("SecretOwnedByConnectionError")(err)
        ? new McpConnectionError({ transport: "remote", message: "Failed to resolve secret" })
        : err,
    ),
  );

const plainStringMap = (
  values: Record<string, McpCredentialInput> | undefined,
): Record<string, string> | undefined => {
  if (!values) return undefined;
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const resolveMcpBindingValueMap = (
  ctx: PluginCtx<McpBindingStore>,
  values: Record<string, ConfiguredMcpCredentialValue> | undefined,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly targetScope?: string;
    readonly missingLabel: string;
  },
): Effect.Effect<Record<string, string> | undefined, McpConnectionError | StorageFailure> =>
  Effect.gen(function* () {
    if (!values) return undefined;
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = yield* resolveMcpSourceBinding(
        ctx,
        params.sourceId,
        params.sourceScope,
        value.slot,
      );
      if (binding?.value.kind === "secret") {
        const secret = yield* ctx.secrets.getAtScope(binding.value.secretId, binding.scopeId).pipe(
          Effect.catchTag("SecretOwnedByConnectionError", () =>
            Effect.fail(
              new McpConnectionError({
                transport: "remote",
                message: `Failed to resolve secret for ${params.missingLabel} "${name}"`,
              }),
            ),
          ),
        );
        if (secret === null) {
          return yield* new McpConnectionError({
            transport: "remote",
            message: `Missing secret "${binding.value.secretId}" for ${params.missingLabel} "${name}"`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }
      return yield* new McpConnectionError({
        transport: "remote",
        message: `Missing binding for ${params.missingLabel} "${name}"`,
      });
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });

const resolveMcpCredentialInputMap = (
  ctx: PluginCtx<McpBindingStore>,
  values: Record<string, McpCredentialInput> | undefined,
  params: {
    readonly sourceId: string;
    readonly sourceScope: string;
    readonly targetScope?: string;
    readonly missingLabel: string;
  },
): Effect.Effect<Record<string, string> | undefined, McpConnectionError | StorageFailure> =>
  Effect.gen(function* () {
    if (!values) return undefined;
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      if ("kind" in value) {
        const slotResolved = yield* resolveMcpBindingValueMap(
          ctx,
          { [name]: value },
          {
            sourceId: params.sourceId,
            sourceScope: params.sourceScope,
            missingLabel: params.missingLabel,
          },
        );
        if (slotResolved?.[name] !== undefined) resolved[name] = slotResolved[name];
        continue;
      }
      const secretScope =
        "secretScopeId" in value
          ? (value.secretScopeId ?? value.targetScope)
          : (params.targetScope ?? params.sourceScope);
      const secret = yield* ctx.secrets.getAtScope(SecretId.make(value.secretId), secretScope).pipe(
        Effect.catchTag("SecretOwnedByConnectionError", () =>
          Effect.fail(
            new McpConnectionError({
              transport: "remote",
              message: `Failed to resolve secret for ${params.missingLabel} "${name}"`,
            }),
          ),
        ),
      );
      if (secret === null) {
        return yield* new McpConnectionError({
          transport: "remote",
          message: `Missing secret "${value.secretId}" for ${params.missingLabel} "${name}"`,
        });
      }
      resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });

const resolveMcpHeaderAuth = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  auth: McpConnectionAuth,
): Effect.Effect<Record<string, string>, McpConnectionError | StorageFailure> =>
  Effect.gen(function* () {
    if (auth.kind !== "header") return {};
    const binding = yield* resolveMcpSourceBinding(ctx, sourceId, sourceScope, auth.secretSlot);
    if (binding?.value.kind === "secret") {
      const secret = yield* ctx.secrets.getAtScope(binding.value.secretId, binding.scopeId).pipe(
        Effect.catchTag("SecretOwnedByConnectionError", () =>
          Effect.fail(
            new McpConnectionError({
              transport: "remote",
              message: `Failed to resolve header auth binding "${auth.secretSlot}"`,
            }),
          ),
        ),
      );
      if (secret === null) {
        return yield* new McpConnectionError({
          transport: "remote",
          message: `Missing secret for header auth binding "${auth.secretSlot}"`,
        });
      }
      return { [auth.headerName]: auth.prefix ? `${auth.prefix}${secret}` : secret };
    }
    if (binding?.value.kind === "text") {
      return {
        [auth.headerName]: auth.prefix ? `${auth.prefix}${binding.value.text}` : binding.value.text,
      };
    }
    return yield* new McpConnectionError({
      transport: "remote",
      message: `Missing header auth binding "${auth.secretSlot}"`,
    });
  });

const resolveMcpStoredOauthProvider = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  auth: McpConnectionAuth,
): Effect.Effect<OAuthClientProvider | undefined, McpConnectionError | StorageFailure> =>
  Effect.gen(function* () {
    if (auth.kind !== "oauth2") return undefined;
    const binding = yield* resolveMcpSourceBinding(ctx, sourceId, sourceScope, auth.connectionSlot);
    if (binding?.value.kind !== "connection") {
      return yield* new McpConnectionError({
        transport: "remote",
        message: `Missing OAuth connection binding for MCP source "${sourceId}"`,
      });
    }
    const connectionId = binding.value.connectionId;
    const accessToken = yield* ctx.connections
      .accessTokenAtScope(connectionId, binding.scopeId)
      .pipe(
        Effect.mapError(
          ({ message }) =>
            new McpConnectionError({
              transport: "remote",
              message: `Failed to resolve OAuth connection "${connectionId}": ${message}`,
            }),
        ),
      );
    return makeOAuthProvider(accessToken);
  });

const resolveMcpInputAuth = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  targetScope: string | undefined,
  auth: McpConnectionAuthInput | undefined,
): Effect.Effect<
  { readonly headers: Record<string, string>; readonly authProvider?: OAuthClientProvider },
  McpConnectionError | StorageFailure
> =>
  Effect.gen(function* () {
    if (!auth || auth.kind === "none") return { headers: {} };
    if (auth.kind === "header") {
      if ("secretSlot" in auth) {
        const headers = yield* resolveMcpHeaderAuth(ctx, sourceId, sourceScope, auth);
        return { headers };
      }
      const secretScope = auth.secretScopeId ?? auth.targetScope ?? targetScope ?? sourceScope;
      const secret = yield* ctx.secrets.getAtScope(SecretId.make(auth.secretId), secretScope).pipe(
        Effect.catchTag("SecretOwnedByConnectionError", () =>
          Effect.fail(
            new McpConnectionError({
              transport: "remote",
              message: `Failed to resolve secret "${auth.secretId}"`,
            }),
          ),
        ),
      );
      if (secret === null) {
        return yield* new McpConnectionError({
          transport: "remote",
          message: `Failed to resolve secret "${auth.secretId}"`,
        });
      }
      return {
        headers: { [auth.headerName]: auth.prefix ? `${auth.prefix}${secret}` : secret },
      };
    }
    const connection =
      "connectionId" in auth
        ? { id: ConnectionId.make(auth.connectionId), scope: targetScope ?? sourceScope }
        : yield* Effect.gen(function* () {
            const binding = yield* resolveMcpSourceBinding(
              ctx,
              sourceId,
              sourceScope,
              auth.connectionSlot,
            );
            return binding?.value.kind === "connection"
              ? { id: binding.value.connectionId, scope: binding.scopeId }
              : null;
          });
    if (connection === null) {
      return yield* new McpConnectionError({
        transport: "remote",
        message: `Missing OAuth connection binding for MCP source "${sourceId}"`,
      });
    }
    const accessToken = yield* ctx.connections
      .accessTokenAtScope(connection.id, connection.scope)
      .pipe(
        Effect.mapError(
          ({ message }) =>
            new McpConnectionError({
              transport: "remote",
              message: `Failed to resolve OAuth connection "${connection.id}": ${message}`,
            }),
        ),
      );
    return { headers: {}, authProvider: makeOAuthProvider(accessToken) };
  });

// ---------------------------------------------------------------------------
// Shared connector resolution — reads secrets, builds stdio/remote input
// ---------------------------------------------------------------------------

const resolveConnectorInput = (
  sourceId: string,
  sourceScope: string,
  sd: McpStoredSourceData,
  ctx: PluginCtx<McpBindingStore>,
  allowStdio: boolean,
): Effect.Effect<ConnectorInput, McpConnectionError | StorageFailure> => {
  if (sd.transport === "stdio") {
    if (!allowStdio) {
      return Effect.fail(
        new McpConnectionError({
          transport: "stdio",
          message:
            "MCP stdio transport is disabled. Enable it by passing `dangerouslyAllowStdioMCP: true` to mcpPlugin() — only safe for trusted local contexts.",
        }),
      );
    }
    return Effect.succeed({
      transport: "stdio" as const,
      command: sd.command,
      args: sd.args,
      env: sd.env,
      cwd: sd.cwd,
    });
  }

  return Effect.gen(function* () {
    const resolvedHeaders = yield* resolveMcpBindingValueMap(ctx, sd.headers, {
      sourceId,
      sourceScope,
      missingLabel: "header",
    });
    const resolvedQueryParams = yield* resolveMcpBindingValueMap(ctx, sd.queryParams, {
      sourceId,
      sourceScope,
      missingLabel: "query parameter",
    });
    const headers: Record<string, string> = { ...(resolvedHeaders ?? {}) };

    const auth = sd.auth;
    if (auth.kind === "header") {
      Object.assign(headers, yield* resolveMcpHeaderAuth(ctx, sourceId, sourceScope, auth));
    }
    const authProvider = yield* resolveMcpStoredOauthProvider(ctx, sourceId, sourceScope, auth);

    return {
      transport: "remote" as const,
      endpoint: sd.endpoint,
      remoteTransport: sd.remoteTransport,
      queryParams: resolvedQueryParams,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      authProvider,
    };
  });
};

// ---------------------------------------------------------------------------
// Connection cache — kept as plugin-module state so both invokeTool and
// the close hook see the same ScopedCache instance. The ScopedCache's
// lookup key is the stringified stored source data identity.
// ---------------------------------------------------------------------------

interface McpRuntime {
  readonly connectionCache: ScopedCache.ScopedCache<string, McpConnection, McpConnectionError>;
  readonly pendingConnectors: Map<string, Effect.Effect<McpConnection, McpConnectionError>>;
  readonly cacheScope: Scope.Closeable;
}

const makeRuntime = (): Effect.Effect<McpRuntime, never> =>
  Effect.gen(function* () {
    const cacheScope = yield* Scope.make();
    const pendingConnectors = new Map<string, Effect.Effect<McpConnection, McpConnectionError>>();
    const connectionCache = yield* ScopedCache.make({
      lookup: (key: string) =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            const connector = pendingConnectors.get(key);
            if (!connector) {
              return Effect.fail(
                new McpConnectionError({
                  transport: "auto",
                  message: `No pending connector for key: ${key}`,
                }),
              );
            }
            return connector;
          }),
          (connection) =>
            Effect.ignore(
              Effect.tryPromise({
                try: () => connection.close(),
                catch: () =>
                  new McpConnectionError({
                    transport: "auto",
                    message: "Failed to close MCP connection",
                  }),
              }),
            ),
        ),
      capacity: 64,
      timeToLive: Duration.minutes(5),
    }).pipe(Scope.provide(cacheScope));

    return { connectionCache, pendingConnectors, cacheScope };
  });

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface McpPluginOptions {
  /**
   * Allow configuring stdio-transport MCP sources. Off by default.
   *
   * Stdio sources spawn a local subprocess that inherits the parent
   * `process.env`. Only enable for trusted single-user contexts.
   */
  readonly dangerouslyAllowStdioMCP?: boolean;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
}

const secretRef = (id: string): string => `${SECRET_REF_PREFIX}${id}`;

const authToConfig = (auth: McpConnectionAuthInput | undefined): McpAuthConfig | undefined => {
  if (!auth) return undefined;
  if (auth.kind === "none") return { kind: "none" };
  if (auth.kind === "header") {
    if (!("secretId" in auth)) return undefined;
    return {
      kind: "header",
      headerName: auth.headerName,
      secret: secretRef(auth.secretId),
      prefix: auth.prefix,
    };
  }
  if (!("connectionId" in auth)) return undefined;
  return {
    kind: "oauth2",
    connectionId: auth.connectionId,
  };
};

const toMcpConfigEntry = (
  namespace: string,
  sourceName: string,
  config: McpSourceConfig,
): SourceConfig => {
  if (config.transport === "stdio") {
    const entry: McpStdioConfigEntry = {
      kind: "mcp",
      transport: "stdio",
      name: sourceName,
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      namespace,
    };
    return entry;
  }
  const entry: McpRemoteConfigEntry = {
    kind: "mcp",
    transport: "remote",
    name: sourceName,
    endpoint: config.endpoint,
    remoteTransport: config.remoteTransport,
    queryParams: plainStringMap(config.queryParams),
    headers: plainStringMap(config.headers),
    namespace,
    auth: authToConfig(config.auth),
  };
  return entry;
};

export const mcpPlugin = definePlugin((options?: McpPluginOptions) => {
  const allowStdio = options?.dangerouslyAllowStdioMCP ?? false;
  // Per-plugin-instance runtime holder. Captured by closures in
  // `extension`, `invokeTool`, and `close`, so all three see the same
  // connection cache across a single createExecutor lifecycle.
  const runtimeRef: { current: McpRuntime | null } = { current: null };

  const ensureRuntime = (): Effect.Effect<McpRuntime, never> =>
    runtimeRef.current
      ? Effect.succeed(runtimeRef.current)
      : makeRuntime().pipe(
          Effect.tap((rt) =>
            Effect.sync(() => {
              runtimeRef.current = rt;
            }),
          ),
        );

  return {
    id: "mcp" as const,
    packageName: "@executor-js/plugin-mcp",
    // Surfaced to the client bundle via the Vite plugin (see
    // `@executor-js/vite-plugin`). The MCP `./client` factory reads
    // `allowStdio` and gates the stdio tab + presets in AddMcpSource —
    // so the server's `dangerouslyAllowStdioMCP` flag is the single
    // source of truth for both runtime and UI.
    clientConfig: { allowStdio },
    schema: mcpSchema,
    storage: (deps): McpBindingStore => makeMcpStore(deps),

    extension: (ctx) => {
      const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
      const probeEndpoint = (input: string | McpProbeEndpointInput) =>
        Effect.gen(function* () {
          const endpoint = typeof input === "string" ? input : input.endpoint;
          const trimmed = endpoint.trim();
          if (!trimmed) {
            return yield* new McpConnectionError({
              transport: "remote",
              message: "Endpoint URL is required",
            });
          }

          const name = yield* Effect.try({
            try: () => new URL(trimmed).hostname,
            catch: () => "mcp",
          }).pipe(Effect.orElseSucceed(() => "mcp"));
          const namespace = deriveMcpNamespace({ endpoint: trimmed });

          const probeHeaders =
            typeof input === "string"
              ? undefined
              : yield* resolveSecretBackedMap(input.headers, ctx);
          const probeQueryParams =
            typeof input === "string"
              ? undefined
              : yield* resolveSecretBackedMap(input.queryParams, ctx);

          const connector = createMcpConnector({
            transport: "remote",
            endpoint: trimmed,
            headers: probeHeaders,
            queryParams: probeQueryParams,
          });

          const result = yield* discoverTools(connector).pipe(
            Effect.map((m) => ({ ok: true as const, manifest: m })),
            Effect.catch(() => Effect.succeed({ ok: false as const, manifest: null })),
            Effect.withSpan("mcp.plugin.discover_tools"),
          );

          if (result.ok && result.manifest) {
            return {
              connected: true,
              requiresOAuth: false,
              supportsDynamicRegistration: false,
              name: result.manifest.server?.name ?? name,
              namespace,
              toolCount: result.manifest.tools.length,
              serverName: result.manifest.server?.name ?? null,
            } satisfies McpProbeResult;
          }

          // Before asking the core OAuth service to look for metadata,
          // confirm the endpoint actually speaks MCP. An OAuth-protected
          // non-MCP service (e.g. a GraphQL API whose host publishes
          // RFC 9728 + 8414 metadata) would otherwise pass the OAuth
          // probe and be misclassified as MCP. The shape probe rejects
          // anything whose initialize response isn't 2xx or 401+Bearer.
          const shape = yield* probeMcpEndpointShape(trimmed, {
            httpClientLayer,
            headers: probeHeaders,
            queryParams: probeQueryParams,
          });
          if (shape.kind !== "mcp") {
            return yield* new McpConnectionError({
              transport: "remote",
              message: userFacingProbeMessage(shape),
            });
          }

          const probeResult = yield* ctx.oauth
            .probe({
              endpoint: trimmed,
              headers: probeHeaders,
              queryParams: probeQueryParams,
            })
            .pipe(
              Effect.map((oauth) => ({ ok: true as const, oauth })),
              Effect.catch(() => Effect.succeed({ ok: false as const, oauth: null })),
              Effect.withSpan("mcp.plugin.probe_oauth"),
            );

          if (probeResult.ok) {
            return {
              connected: false,
              requiresOAuth: true,
              supportsDynamicRegistration: probeResult.oauth.supportsDynamicRegistration,
              name,
              namespace,
              toolCount: null,
              serverName: null,
            } satisfies McpProbeResult;
          }

          return yield* new McpConnectionError({
            transport: "remote",
            message:
              "This server requires authentication, but OAuth metadata wasn't found. Add credentials (Authorization header, query parameter, or API key) below and retry.",
          });
        }).pipe(
          Effect.withSpan("mcp.plugin.probe_endpoint", {
            attributes: { "mcp.endpoint": typeof input === "string" ? input : input.endpoint },
          }),
        );

      const configFile = options?.configFile;

      const addSource = (config: McpSourceConfig) =>
        Effect.gen(function* () {
          const namespace = normalizeNamespace(config);
          const canonicalRemote =
            config.transport === "remote"
              ? {
                  headers: canonicalizeCredentialMap(config.headers, mcpHeaderSlot),
                  queryParams: canonicalizeCredentialMap(config.queryParams, mcpQueryParamSlot),
                  auth: canonicalizeAuth(config.auth),
                }
              : null;
          const directBindings = canonicalRemote
            ? [
                ...canonicalRemote.headers.bindings,
                ...canonicalRemote.queryParams.bindings,
                ...canonicalRemote.auth.bindings,
              ]
            : [];
          for (const binding of directBindings) {
            const bindingTargetScope = yield* targetScopeForBinding(
              config.transport === "remote" ? config.credentialTargetScope : undefined,
              binding,
            );
            yield* validateMcpBindingTarget(ctx, {
              sourceId: namespace,
              sourceScope: config.scope,
              targetScope: bindingTargetScope,
            });
          }
          const targetScope =
            config.transport === "remote" && directBindings[0]
              ? yield* targetScopeForBinding(config.credentialTargetScope, directBindings[0])
              : undefined;
          const sd = toStoredSourceData(
            config,
            canonicalRemote
              ? {
                  headers: canonicalRemote.headers.values,
                  queryParams: canonicalRemote.queryParams.values,
                  auth: canonicalRemote.auth.auth,
                }
              : undefined,
          );

          // Stdio sources are gated — a resolver failure there is a
          // config error the admin must fix before the source makes
          // sense to persist at all. For remote sources we defer the
          // resolver failure: auth might not be ready yet (oauth2
          // connection awaiting per-user sign-in, header secret
          // awaiting upload) but the source row should still land so
          // it shows up in the list and exposes a Sign-in affordance.
          const resolved = yield* (
            config.transport === "remote"
              ? Effect.gen(function* () {
                  const resolvedHeaders = yield* resolveMcpCredentialInputMap(ctx, config.headers, {
                    sourceId: namespace,
                    sourceScope: config.scope,
                    targetScope,
                    missingLabel: "header",
                  });
                  const resolvedQueryParams = yield* resolveMcpCredentialInputMap(
                    ctx,
                    config.queryParams,
                    {
                      sourceId: namespace,
                      sourceScope: config.scope,
                      targetScope,
                      missingLabel: "query parameter",
                    },
                  );
                  const resolvedAuth = yield* resolveMcpInputAuth(
                    ctx,
                    namespace,
                    config.scope,
                    targetScope,
                    config.auth,
                  );
                  const headers = {
                    ...(resolvedHeaders ?? {}),
                    ...resolvedAuth.headers,
                  };
                  return {
                    transport: "remote" as const,
                    endpoint: config.endpoint,
                    remoteTransport: config.remoteTransport ?? "auto",
                    queryParams: resolvedQueryParams,
                    headers: Object.keys(headers).length > 0 ? headers : undefined,
                    authProvider: resolvedAuth.authProvider,
                  };
                })
              : resolveConnectorInput(namespace, config.scope, sd, ctx, allowStdio)
          ).pipe(
            Effect.result,
            Effect.withSpan("mcp.plugin.resolve_connector", {
              attributes: {
                "mcp.source.namespace": namespace,
                "mcp.source.transport": sd.transport,
              },
            }),
          );

          if (Result.isFailure(resolved) && sd.transport === "stdio") {
            return yield* Effect.fail(resolved.failure);
          }

          // Try discovery only if we have a live connector input.
          // Otherwise fall straight through to the persist step with
          // an empty manifest and surface the resolver failure to
          // the caller at the end.
          const discovery: Result.Result<
            McpToolManifest,
            McpToolDiscoveryError | McpConnectionError | StorageFailure
          > = Result.isSuccess(resolved)
            ? yield* discoverTools(createMcpConnector(resolved.success)).pipe(
                Effect.mapError(
                  ({ message }) =>
                    new McpToolDiscoveryError({
                      stage: "list_tools",
                      message: `MCP discovery failed: ${message}`,
                    }),
                ),
                Effect.result,
                Effect.withSpan("mcp.plugin.discover_tools", {
                  attributes: { "mcp.source.namespace": namespace },
                }),
              )
            : Result.fail(resolved.failure);
          const manifest = Result.isSuccess(discovery)
            ? discovery.success
            : { server: undefined, tools: [] as const };

          const sourceName = config.name ?? manifest.server?.name ?? namespace;

          yield* ctx
            .transaction(
              Effect.gen(function* () {
                // Remove stale rows at the target scope (plugin-owned).
                // Pinning scope keeps a shadowed outer-scope row intact
                // when a per-user addSource re-uses the same namespace.
                yield* ctx.storage.removeBindingsByNamespace(namespace, config.scope);
                yield* ctx.storage.removeSource(namespace, config.scope);

                yield* ctx.storage.putSource({
                  namespace,
                  scope: config.scope,
                  name: sourceName,
                  config: sd,
                });

                yield* ctx.storage.putBindings(
                  namespace,
                  config.scope,
                  manifest.tools.map((e) => ({
                    toolId: `${namespace}.${e.toolId}`,
                    binding: toBinding(e),
                  })),
                );

                yield* ctx.core.sources.register({
                  id: namespace,
                  scope: config.scope,
                  kind: "mcp",
                  name: sourceName,
                  url: sd.transport === "remote" ? sd.endpoint : undefined,
                  canRemove: true,
                  canRefresh: true,
                  canEdit: sd.transport === "remote",
                  tools: manifest.tools.map((e) => ({
                    name: e.toolId,
                    description: e.description ?? `MCP tool: ${e.toolName}`,
                    inputSchema: e.inputSchema,
                    outputSchema: e.outputSchema,
                  })),
                });

                if (directBindings.length > 0) {
                  for (const binding of directBindings) {
                    const bindingTargetScope = yield* targetScopeForBinding(
                      config.transport === "remote" ? config.credentialTargetScope : undefined,
                      binding,
                    );
                    yield* ctx.credentialBindings.set({
                      targetScope: ScopeId.make(bindingTargetScope),
                      pluginId: MCP_PLUGIN_ID,
                      sourceId: namespace,
                      sourceScope: ScopeId.make(config.scope),
                      slotKey: binding.slot,
                      value: binding.value,
                    });
                  }
                }
              }),
            )
            .pipe(
              Effect.withSpan("mcp.plugin.persist_source", {
                attributes: {
                  "mcp.source.namespace": namespace,
                  "mcp.source.tool_count": manifest.tools.length,
                },
              }),
            );

          if (configFile) {
            yield* configFile
              .upsertSource(toMcpConfigEntry(namespace, sourceName, config))
              .pipe(Effect.withSpan("mcp.plugin.config_file.upsert"));
          }

          if (Result.isFailure(discovery)) {
            return yield* Effect.fail(discovery.failure);
          }
          return { toolCount: manifest.tools.length, namespace };
        }).pipe(
          Effect.withSpan("mcp.plugin.add_source", {
            attributes: {
              "mcp.source.transport": config.transport,
              "mcp.source.name": config.name,
            },
          }),
        );

      const removeSource = (namespace: string, scope: string) =>
        Effect.gen(function* () {
          yield* ctx
            .transaction(
              Effect.gen(function* () {
                yield* ctx.credentialBindings.removeForSource({
                  pluginId: MCP_PLUGIN_ID,
                  sourceId: namespace,
                  sourceScope: ScopeId.make(scope),
                });
                yield* ctx.storage.removeBindingsByNamespace(namespace, scope);
                yield* ctx.storage.removeSource(namespace, scope);
                yield* ctx.core.sources.unregister({ id: namespace, targetScope: scope });
              }),
            )
            .pipe(Effect.withSpan("mcp.plugin.persist_remove"));
          if (configFile) {
            yield* configFile
              .removeSource(namespace)
              .pipe(Effect.withSpan("mcp.plugin.config_file.remove"));
          }
        }).pipe(
          Effect.withSpan("mcp.plugin.remove_source", {
            attributes: { "mcp.source.namespace": namespace },
          }),
        );

      const refreshSource = (namespace: string, scope: string) =>
        Effect.gen(function* () {
          const sd = yield* ctx.storage.getSourceConfig(namespace, scope).pipe(
            Effect.withSpan("mcp.plugin.load_source_config", {
              attributes: { "mcp.source.namespace": namespace },
            }),
          );
          if (!sd) {
            return yield* new McpConnectionError({
              transport: "remote",
              message: `No stored config for MCP source "${namespace}"`,
            });
          }

          const ci = yield* resolveConnectorInput(namespace, scope, sd, ctx, allowStdio).pipe(
            Effect.withSpan("mcp.plugin.resolve_connector", {
              attributes: {
                "mcp.source.namespace": namespace,
                "mcp.source.transport": sd.transport,
              },
            }),
          );
          const manifest = yield* discoverTools(createMcpConnector(ci)).pipe(
            Effect.mapError(
              ({ message }) =>
                new McpToolDiscoveryError({
                  stage: "list_tools",
                  message: `MCP refresh failed: ${message}`,
                }),
            ),
            Effect.withSpan("mcp.plugin.discover_tools", {
              attributes: { "mcp.source.namespace": namespace },
            }),
          );

          const existing = yield* ctx.storage.getSource(namespace, scope);
          const sourceName = manifest.server?.name ?? existing?.name ?? namespace;

          yield* ctx
            .transaction(
              Effect.gen(function* () {
                yield* ctx.storage.removeBindingsByNamespace(namespace, scope);
                yield* ctx.core.sources.unregister({ id: namespace, targetScope: scope });

                yield* ctx.storage.putBindings(
                  namespace,
                  scope,
                  manifest.tools.map((e) => ({
                    toolId: `${namespace}.${e.toolId}`,
                    binding: toBinding(e),
                  })),
                );
                yield* ctx.core.sources.register({
                  id: namespace,
                  scope,
                  kind: "mcp",
                  name: sourceName,
                  url: sd.transport === "remote" ? sd.endpoint : undefined,
                  canRemove: true,
                  canRefresh: true,
                  canEdit: sd.transport === "remote",
                  tools: manifest.tools.map((e) => ({
                    name: e.toolId,
                    description: e.description ?? `MCP tool: ${e.toolName}`,
                    inputSchema: e.inputSchema,
                    outputSchema: e.outputSchema,
                  })),
                });
              }),
            )
            .pipe(
              Effect.withSpan("mcp.plugin.persist_source", {
                attributes: {
                  "mcp.source.namespace": namespace,
                  "mcp.source.tool_count": manifest.tools.length,
                },
              }),
            );

          return { toolCount: manifest.tools.length };
        }).pipe(
          Effect.withSpan("mcp.plugin.refresh_source", {
            attributes: { "mcp.source.namespace": namespace },
          }),
        );

      const updateSource = (namespace: string, scope: string, input: McpUpdateSourceInput) =>
        Effect.gen(function* () {
          const existing = yield* ctx.storage.getSource(namespace, scope);
          if (!existing || existing.config.transport !== "remote") return;

          const canonicalHeaders =
            input.headers !== undefined
              ? canonicalizeCredentialMap(input.headers, mcpHeaderSlot)
              : null;
          const canonicalQueryParams =
            input.queryParams !== undefined
              ? canonicalizeCredentialMap(input.queryParams, mcpQueryParamSlot)
              : null;
          const canonicalAuth = input.auth !== undefined ? canonicalizeAuth(input.auth) : null;
          const directBindings = [
            ...(canonicalHeaders?.bindings ?? []),
            ...(canonicalQueryParams?.bindings ?? []),
            ...(canonicalAuth?.bindings ?? []),
          ];
          const targetScope = yield* bindingTargetScope(
            input.credentialTargetScope,
            directBindings,
          );
          if (targetScope) {
            yield* validateMcpBindingTarget(ctx, {
              sourceId: namespace,
              sourceScope: scope,
              targetScope,
            });
          }

          const remote = existing.config;
          const updatedConfig: McpStoredSourceData = {
            ...remote,
            ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
            ...(canonicalHeaders ? { headers: canonicalHeaders.values } : {}),
            ...(canonicalAuth ? { auth: canonicalAuth.auth } : {}),
            ...(canonicalQueryParams ? { queryParams: canonicalQueryParams.values } : {}),
          };

          const affectedPrefixes = [
            ...(input.headers !== undefined ? ["header:"] : []),
            ...(input.queryParams !== undefined ? ["query_param:"] : []),
            ...(input.auth !== undefined ? ["auth:"] : []),
          ];
          const replacementTargetScope = targetScope ?? input.credentialTargetScope ?? scope;
          yield* ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.storage.putSource({
                namespace,
                scope,
                name: input.name?.trim() || existing.name,
                config: updatedConfig,
              });
              if (affectedPrefixes.length > 0 || directBindings.length > 0) {
                yield* ctx.credentialBindings.replaceForSource({
                  targetScope: ScopeId.make(replacementTargetScope),
                  pluginId: MCP_PLUGIN_ID,
                  sourceId: namespace,
                  sourceScope: ScopeId.make(scope),
                  slotPrefixes: affectedPrefixes,
                  bindings: directBindings.map((binding) => ({
                    slotKey: binding.slot,
                    value: binding.value,
                  })),
                });
              }
            }),
          );
        }).pipe(
          Effect.withSpan("mcp.plugin.update_source", {
            attributes: { "mcp.source.namespace": namespace },
          }),
        );

      const getSource = (namespace: string, scope: string) =>
        ctx.storage.getSource(namespace, scope).pipe(
          Effect.withSpan("mcp.plugin.get_source", {
            attributes: { "mcp.source.namespace": namespace },
          }),
        );

      return {
        probeEndpoint,
        addSource,
        removeSource,
        refreshSource,
        getSource,
        updateSource,
        listSourceBindings: (sourceId: string, sourceScope: string) =>
          listMcpSourceBindings(ctx, sourceId, sourceScope),
        setSourceBinding: (input: McpSourceBindingInput) =>
          Effect.gen(function* () {
            yield* validateMcpBindingTarget(ctx, {
              sourceId: input.sourceId,
              sourceScope: input.sourceScope,
              targetScope: input.scope,
            });
            const binding = yield* ctx.credentialBindings.set({
              targetScope: input.scope,
              pluginId: MCP_PLUGIN_ID,
              sourceId: input.sourceId,
              sourceScope: input.sourceScope,
              slotKey: input.slot,
              value: input.value,
            });
            return coreBindingToMcpBinding(binding);
          }),
        removeSourceBinding: (sourceId: string, sourceScope: string, slot: string, scope: string) =>
          Effect.gen(function* () {
            yield* validateMcpBindingTarget(ctx, {
              sourceId,
              sourceScope,
              targetScope: scope,
            });
            yield* ctx.credentialBindings.remove({
              targetScope: ScopeId.make(scope),
              pluginId: MCP_PLUGIN_ID,
              sourceId,
              sourceScope: ScopeId.make(sourceScope),
              slotKey: slot,
            });
          }),
      };
    },

    invokeTool: ({ ctx, toolRow, args, elicit }) =>
      Effect.gen(function* () {
        const runtime = yield* ensureRuntime();

        // toolRow.scope_id is the resolved owning scope of the tool
        // (innermost-wins from the executor's stack). The matching
        // mcp_binding + mcp_source rows live at the same scope, so
        // pin every store lookup to it instead of relying on the
        // scoped adapter's stack-wide fall-through.
        const toolScope = toolRow.scope_id;
        const entry = yield* ctx.storage.getBinding(toolRow.id, toolScope).pipe(
          Effect.withSpan("mcp.plugin.load_binding", {
            attributes: { "mcp.tool.name": toolRow.id },
          }),
        );
        if (!entry) {
          return yield* new McpInvocationError({
            toolName: toolRow.id,
            message: `No MCP binding found for tool "${toolRow.id}"`,
          });
        }

        const sd = yield* ctx.storage.getSourceConfig(entry.namespace, toolScope).pipe(
          Effect.withSpan("mcp.plugin.load_source_config", {
            attributes: { "mcp.source.namespace": entry.namespace },
          }),
        );
        if (!sd) {
          return yield* new McpConnectionError({
            transport: "auto",
            message: `No MCP source config for namespace "${entry.namespace}"`,
          });
        }

        return yield* invokeMcpTool({
          toolId: toolRow.id,
          toolName: entry.binding.toolName,
          args,
          sourceData: sd,
          sourceId: entry.namespace,
          sourceScope: toolScope,
          invokerScope: ctx.scopes[0]!.id,
          resolveConnector: () =>
            resolveConnectorInput(entry.namespace, toolScope, sd, ctx, allowStdio).pipe(
              Effect.catchTags({
                StorageError: () =>
                  Effect.fail(
                    new McpConnectionError({
                      transport: sd.transport,
                      message: "Failed to resolve MCP connector storage state",
                    }),
                  ),
                UniqueViolationError: () =>
                  Effect.fail(
                    new McpConnectionError({
                      transport: sd.transport,
                      message: "Failed to resolve MCP connector storage state",
                    }),
                  ),
              }),
              Effect.flatMap((ci) => createMcpConnector(ci)),
              Effect.withSpan("mcp.plugin.resolve_connector", {
                attributes: {
                  "mcp.source.namespace": entry.namespace,
                  "mcp.source.transport": sd.transport,
                },
              }),
            ),
          connectionCache: runtime.connectionCache,
          pendingConnectors: runtime.pendingConnectors,
          elicit,
        });
      }).pipe(
        Effect.withSpan("mcp.plugin.invoke_tool", {
          attributes: {
            "mcp.tool.name": toolRow.id,
            "mcp.tool.source_id": toolRow.source_id,
          },
        }),
      ),

    detect: ({ ctx, url }) =>
      Effect.gen(function* () {
        const httpClientLayer = options?.httpClientLayer ?? ctx.httpClientLayer;
        const trimmed = url.trim();
        if (!trimmed) return null;

        const parsed = yield* Effect.try({
          try: () => new URL(trimmed),
          catch: (cause) => cause,
        }).pipe(Effect.option);
        if (Option.isNone(parsed)) return null;

        const name = parsed.value.hostname || "mcp";
        const namespace = deriveMcpNamespace({ endpoint: trimmed });

        const connector = createMcpConnector({
          transport: "remote",
          endpoint: trimmed,
        });

        const connected = yield* discoverTools(connector).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
          Effect.withSpan("mcp.plugin.discover_tools"),
        );

        if (connected) {
          return new SourceDetectionResult({
            kind: "mcp",
            confidence: "high",
            endpoint: trimmed,
            name,
            namespace,
          });
        }

        // The shape probe inspects the JSON-RPC `initialize` response
        // and only classifies as MCP when the wire shape is
        // unambiguous (2xx + JSON-RPC body, 2xx SSE, or 401 + Bearer +
        // JSON-RPC error envelope). That body-shape gate is what
        // separates real MCP servers — including those that
        // authenticate with static API keys and publish no OAuth
        // metadata — from unrelated OAuth-protected services whose
        // host happens to expose RFC 9728/8414 documents.
        const shape = yield* probeMcpEndpointShape(trimmed, { httpClientLayer });
        if (shape.kind === "mcp") {
          return new SourceDetectionResult({
            kind: "mcp",
            confidence: "high",
            endpoint: trimmed,
            name,
            namespace,
          });
        }

        // Low-confidence URL-token fallback. When wire-shape detection
        // can't confirm MCP (server unreachable, behind unusual auth,
        // returns a non-canonical body, etc.) but the URL itself is a
        // strong hint, surface a candidate so the user can still pick
        // it from the detect dropdown rather than getting nothing.
        if (urlMatchesToken(parsed.value, "mcp")) {
          return new SourceDetectionResult({
            kind: "mcp",
            confidence: "low",
            endpoint: trimmed,
            name,
            namespace,
          });
        }

        return null;
      }).pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.withSpan("mcp.plugin.detect", {
          attributes: { "mcp.endpoint": url },
        }),
      ),

    // Honor upstream destructiveHint from MCP ToolAnnotations.
    // Bindings are fetched per scope so shadowed sources (e.g. an org-level
    // source overridden per-user) each resolve against their own scope's
    // row rather than collapsing onto whichever row the scoped adapter
    // sees first.
    resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
      Effect.gen(function* () {
        const scopes = new Set(toolRows.map((row) => row.scope_id));
        const entries = yield* Effect.forEach(
          [...scopes],
          (scope) =>
            Effect.gen(function* () {
              const list = yield* ctx.storage.listBindingsBySource(sourceId, scope);
              const byId = new Map(list.map((e) => [e.toolId, e.binding]));
              return [scope, byId] as const;
            }),
          { concurrency: "unbounded" },
        );
        const byScope = new Map(entries);

        const out: Record<string, ToolAnnotations> = {};
        for (const row of toolRows) {
          const binding = byScope.get(row.scope_id)?.get(row.id);
          const ann = binding?.annotations;
          if (ann?.destructiveHint === true) {
            out[row.id] = {
              requiresApproval: true,
              approvalDescription: ann.title ?? binding?.toolName ?? row.id,
            };
          } else {
            out[row.id] = { requiresApproval: false };
          }
        }
        return out;
      }),

    removeSource: ({ ctx, sourceId, scope }) =>
      Effect.gen(function* () {
        yield* ctx.transaction(
          Effect.gen(function* () {
            yield* ctx.credentialBindings.removeForSource({
              pluginId: MCP_PLUGIN_ID,
              sourceId,
              sourceScope: ScopeId.make(scope),
            });
            yield* ctx.storage.removeBindingsByNamespace(sourceId, scope);
            yield* ctx.storage.removeSource(sourceId, scope);
          }),
        );
      }),

    usagesForSecret: () => Effect.succeed([]),

    usagesForConnection: () => Effect.succeed([]),

    refreshSource: () => Effect.void,

    // Connection refresh for oauth2-minted sources is owned by the
    // canonical `"oauth2"` ConnectionProvider that core registers via
    // `makeOAuth2Service`. No MCP-specific provider needed.

    close: () =>
      Effect.gen(function* () {
        const runtime = runtimeRef.current;
        if (runtime) {
          runtime.pendingConnectors.clear();
          yield* ScopedCache.invalidateAll(runtime.connectionCache);
          yield* Scope.close(runtime.cacheScope, Exit.void);
          runtimeRef.current = null;
        }
      }).pipe(Effect.withSpan("mcp.plugin.close")),

    // HTTP transport. `McpHandlers` requires `McpExtensionService`; the
    // host satisfies it via the `extensionService` Tag — at boot for
    // local, per request for cloud.
    routes: () => McpGroup,
    handlers: () => McpHandlers,
    extensionService: McpExtensionService,
  };
});

// ---------------------------------------------------------------------------
// McpPluginExtension — shape of `executor.mcp` for consumers that want
// to type against it directly (api/, react/). Mirrors what `extension`
// returns above.
// ---------------------------------------------------------------------------

/**
 * Errors any MCP extension method may surface. The first four are
 * plugin-domain tagged errors that flow directly to clients (4xx, each
 * carrying its own `HttpApiSchema` status). `StorageFailure` covers
 * raw backend failures (`StorageError`) plus `UniqueViolationError`;
 * the HTTP edge (`@executor-js/api`'s `withCapture`) translates
 * `StorageError` to the opaque `InternalError({ traceId })` at Layer
 * composition. `UniqueViolationError` passes through — plugins can
 * `Effect.catchTag` it if they want a friendlier user-facing error.
 */
export type McpExtensionFailure = McpConnectionError | McpToolDiscoveryError | StorageFailure;

export interface McpPluginExtension {
  readonly probeEndpoint: (
    input: string | McpProbeEndpointInput,
  ) => Effect.Effect<McpProbeResult, McpExtensionFailure>;
  readonly addSource: (
    config: McpSourceConfig,
  ) => Effect.Effect<
    { readonly toolCount: number; readonly namespace: string },
    McpExtensionFailure
  >;
  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, McpExtensionFailure>;
  readonly refreshSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<{ readonly toolCount: number }, McpExtensionFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<McpStoredSource | null, McpExtensionFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: McpUpdateSourceInput,
  ) => Effect.Effect<void, McpExtensionFailure>;
  readonly listSourceBindings: (
    sourceId: string,
    sourceScope: string,
  ) => Effect.Effect<readonly McpSourceBindingRef[], StorageFailure>;
  readonly setSourceBinding: (
    input: McpSourceBindingInput,
  ) => Effect.Effect<McpSourceBindingRef, StorageFailure>;
  readonly removeSourceBinding: (
    sourceId: string,
    sourceScope: string,
    slot: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
}
