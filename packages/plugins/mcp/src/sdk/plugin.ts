import {
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Scope,
  Schema,
  ScopedCache,
} from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  type CredentialBindingRef,
  type CredentialBindingValue,
  ScopeId,
  SourceDetectionResult,
  ToolResult,
  authToolFailure,
  defaultSourceInstallScopeId,
  definePlugin,
  tool,
  resolveSecretBackedMap as resolveSharedSecretBackedMap,
  type PluginCtx,
  type StaticToolSchema,
  type StorageFailure,
  StorageError,
  type ToolAnnotations,
} from "@executor-js/sdk/core";
import {
  compileHttpNamedCredentialMap,
  OAuth2SourceConfig,
  httpCredentialInputToBindingValue,
  type HttpConfiguredValueInput,
} from "@executor-js/sdk/http-source";

import { makeMcpStore, type McpBindingStore, type McpStoredSource } from "./binding-store";
import { createMcpConnector, type ConnectorInput, type McpConnection } from "./connection";
import { discoverTools } from "./discover";
import {
  McpAuthRequiredError,
  McpConnectionError,
  McpInvocationError,
  McpToolDiscoveryError,
} from "./errors";
import { invokeMcpTool } from "./invoke";
import { deriveMcpNamespace, type McpToolManifest, type McpToolManifestEntry } from "./manifest";
import { mcpPresets } from "./presets";
import { probeMcpEndpointShape, type McpShapeProbeResult } from "./probe-shape";
import {
  MCP_OAUTH_CLIENT_ID_SLOT,
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  MCP_OAUTH_CONNECTION_SLOT,
  McpConnectionAuthInput,
  McpConfiguredValueInput,
  McpCredentialInput,
  McpRemoteTransport,
  McpToolBinding,
  mcpHeaderSlot,
  mcpQueryParamSlot,
  type McpConnectionAuth,
  type McpConfiguredValueInput as McpConfiguredValueInputType,
  SecretBackedValue,
  type McpStoredSourceData,
  type ConfiguredMcpCredentialValue,
} from "./types";

import {
  type ConfigFileSink,
  type ConfigHeaderValue,
  type McpAuthConfig,
  type McpRemoteSourceConfig as McpRemoteConfigEntry,
  type McpStdioSourceConfig as McpStdioConfigEntry,
  type SourceConfig,
  headerToConfigValue,
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
  readonly queryParams?: Record<string, McpConfiguredValueInputType>;
  readonly headers?: Record<string, McpConfiguredValueInputType>;
  readonly namespace?: string;
  readonly oauth2?: OAuth2SourceConfig;
  readonly credentials?: McpInitialCredentialsInput;
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
type McpConfigFileRemoteSourceConfig = Omit<
  McpRemoteSourceConfig,
  "headers" | "queryParams" | "oauth2"
> & {
  readonly headers?: Record<string, McpCredentialInput | McpConfiguredValueInputType>;
  readonly queryParams?: Record<string, McpCredentialInput | McpConfiguredValueInputType>;
  readonly auth?: McpConnectionAuthInput;
};
type McpConfigFileSourceConfig = McpConfigFileRemoteSourceConfig | McpStdioSourceConfig;

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

const McpConfigureSourcePayloadSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, McpCredentialInput)),
  queryParams: Schema.optional(Schema.Record(Schema.String, McpCredentialInput)),
  auth: Schema.optional(McpConnectionAuthInput),
});
const McpConfigureSourceInputSchema = Schema.Struct({
  scope: Schema.String,
  ...McpConfigureSourcePayloadSchema.fields,
});
export type McpConfigureSourceInput = typeof McpConfigureSourceInputSchema.Type;

const McpInitialCredentialsInputSchema = Schema.Struct({
  scope: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, McpCredentialInput)),
  queryParams: Schema.optional(Schema.Record(Schema.String, McpCredentialInput)),
  auth: Schema.optional(McpConnectionAuthInput),
});
type McpInitialCredentialsInput = typeof McpInitialCredentialsInputSchema.Type;

const McpRemoteAddSourceInputSchema = Schema.Struct({
  transport: Schema.Literal("remote"),
  name: Schema.String,
  endpoint: Schema.String,
  remoteTransport: Schema.optional(McpRemoteTransport),
  queryParams: Schema.optional(Schema.Record(Schema.String, McpConfiguredValueInput)),
  headers: Schema.optional(Schema.Record(Schema.String, McpConfiguredValueInput)),
  namespace: Schema.optional(Schema.String),
  oauth2: Schema.optional(OAuth2SourceConfig),
  credentials: Schema.optional(McpInitialCredentialsInputSchema),
});

const McpStdioAddSourceInputSchema = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});

const McpAddSourceInputSchema = Schema.Union([
  McpRemoteAddSourceInputSchema,
  McpStdioAddSourceInputSchema,
]);

const McpAddSourceOutputSchema = Schema.Struct({
  namespace: Schema.String,
  source: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
  }),
  toolCount: Schema.Number,
  discovery: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["ok", "failed"]),
      message: Schema.optional(Schema.String),
      stage: Schema.optional(Schema.String),
    }),
  ),
});

const McpProbeEndpointInputSchema = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, SecretBackedValue)),
  queryParams: Schema.optional(Schema.Record(Schema.String, SecretBackedValue)),
});

const McpProbeEndpointOutputSchema = Schema.Struct({
  connected: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  namespace: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
});

const McpGetSourceInputSchema = Schema.Struct({
  namespace: Schema.String,
  scope: Schema.String,
});

const McpGetSourceOutputSchema = Schema.Struct({
  source: Schema.NullOr(Schema.Unknown),
});

const McpStaticConfigureSourceInputSchema = Schema.Struct({
  source: Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
  }),
  scope: Schema.String,
  ...McpConfigureSourcePayloadSchema.fields,
});

const McpStaticConfigureSourceOutputSchema = Schema.Struct({
  configured: Schema.Boolean,
});

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const mcpToolFailure = (code: string, message: string, details?: unknown) =>
  ToolResult.fail({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

const mcpAuthToolFailure = (failure: McpAuthRequiredError) =>
  authToolFailure({
    code: failure.code,
    message: failure.message,
    source: { id: failure.sourceId, scope: failure.sourceScope },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
      ...(failure.slotKey ? { slotKey: failure.slotKey } : {}),
      ...(failure.secretId ? { secretId: failure.secretId } : {}),
      ...(failure.connectionId ? { connectionId: failure.connectionId } : {}),
    },
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.details !== undefined
      ? {
          upstream: {
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            details: failure.details,
          },
        }
      : {}),
    recovery: { configureSourceTool: "executor.mcp.configureSource" },
  });

const McpAddSourceInputStandardSchema = schemaToStaticToolSchema(McpAddSourceInputSchema);
const McpAddSourceOutputStandardSchema = schemaToStaticToolSchema(McpAddSourceOutputSchema);
const McpProbeEndpointInputStandardSchema = schemaToStaticToolSchema(McpProbeEndpointInputSchema);
const McpProbeEndpointOutputStandardSchema = schemaToStaticToolSchema(McpProbeEndpointOutputSchema);
const McpGetSourceInputStandardSchema = schemaToStaticToolSchema(McpGetSourceInputSchema);
const McpGetSourceOutputStandardSchema = schemaToStaticToolSchema(McpGetSourceOutputSchema);
const McpStaticConfigureSourceInputStandardSchema = schemaToStaticToolSchema(
  McpStaticConfigureSourceInputSchema,
);
const McpStaticConfigureSourceOutputStandardSchema = schemaToStaticToolSchema(
  McpStaticConfigureSourceOutputSchema,
);

export type McpProbeEndpointInput = typeof McpProbeEndpointInputSchema.Type;

const resolveStaticScopeInput = (
  ctx: { readonly scopes: readonly { readonly id: ScopeId; readonly name: string }[] },
  value: string,
): string =>
  String(
    ctx.scopes.find((scope) => scope.name === value || String(scope.id) === value)?.id ?? value,
  );

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

type JsonSchemaObject = Record<string, unknown> & {
  readonly properties?: Record<string, unknown>;
};

const McpCallToolResultJsonSchema = z.toJSONSchema(CallToolResultSchema) as JsonSchemaObject;

const mcpCallToolResultOutputSchema = (structuredContentSchema?: unknown): JsonSchemaObject => {
  const defaultStructuredContentSchema =
    McpCallToolResultJsonSchema.properties?.structuredContent ?? {};

  return {
    ...McpCallToolResultJsonSchema,
    properties: {
      ...McpCallToolResultJsonSchema.properties,
      structuredContent:
        structuredContentSchema === undefined
          ? defaultStructuredContentSchema
          : structuredContentSchema,
      isError: { const: false },
    },
    required:
      structuredContentSchema === undefined ? ["content"] : ["content", "structuredContent"],
  };
};

const toBinding = (entry: McpToolManifestEntry): McpToolBinding =>
  McpToolBinding.make({
    toolId: entry.toolId,
    toolName: entry.toolName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    annotations: entry.annotations,
  });

const MCP_PLUGIN_ID = "mcp";
const McpTextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const McpToolCallEnvelope = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
});

const decodeMcpTextContent = Schema.decodeUnknownOption(McpTextContent);
const decodeMcpToolCallEnvelope = Schema.decodeUnknownOption(McpToolCallEnvelope);

const extractMcpErrorMessage = (content: unknown): string => {
  if (Array.isArray(content)) {
    for (const item of content) {
      const decoded = Option.getOrUndefined(decodeMcpTextContent(item));
      if (decoded !== undefined && decoded.text.length > 0) return decoded.text;
    }
  }
  return "MCP tool returned an error";
};

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
  return Match.value(shape.category).pipe(
    Match.when(
      "auth-required",
      () =>
        "This server requires authentication. Add credentials (Authorization header, query parameter, or API key) below and retry.",
    ),
    Match.when(
      "wrong-shape",
      () =>
        "This URL doesn't appear to host an MCP server. Double-check the address, including the path.",
    ),
    Match.exhaustive,
  );
};

const scopeRanks = (ctx: PluginCtx<McpBindingStore>): ReadonlyMap<string, number> =>
  new Map(ctx.scopes.map((scope, index) => [String(scope.id), index]));

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: string): number =>
  ranks.get(scopeId) ?? Infinity;

const resolveMcpSourceBinding = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  slot: string,
): Effect.Effect<CredentialBindingRef | null, StorageFailure> =>
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
    return binding ?? null;
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

const canonicalizeCredentialMap = compileHttpNamedCredentialMap;

const canonicalizeConfiguredValueMap = (
  values: Record<string, McpConfiguredValueInputType> | undefined,
  slotForName: (name: string) => string,
): Record<string, ConfiguredMcpCredentialValue> => {
  const next: Record<string, ConfiguredMcpCredentialValue> = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      next[name] = value;
      continue;
    }
    next[name] = {
      kind: "binding",
      slot: slotForName(name),
      prefix: value.prefix,
    };
  }
  return next;
};

const resolveConfiguredValueMap = (
  values: Record<string, HttpConfiguredValueInput> | undefined,
): Record<string, string> | undefined => {
  if (!values) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") resolved[name] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
};

const authFromOAuth2Source = (oauth2: OAuth2SourceConfig | undefined): McpConnectionAuth =>
  oauth2
    ? {
        kind: "oauth2",
        connectionSlot: oauth2.connectionSlot,
        clientIdSlot: oauth2.clientIdSlot,
        ...(oauth2.clientSecretSlot ? { clientSecretSlot: oauth2.clientSecretSlot } : {}),
      }
    : { kind: "none" };

const canonicalizeAuth = (
  auth: McpConnectionAuthInput | undefined,
): {
  readonly auth: McpConnectionAuth;
  readonly bindings: ReadonlyArray<{
    readonly slot: string;
    readonly value: CredentialBindingValue;
    readonly targetScope?: string;
  }>;
} => {
  if (!auth || "kind" in auth || !auth.oauth2) return { auth: { kind: "none" }, bindings: [] };
  const oauth = auth.oauth2;
  const bindings: Array<{ slot: string; value: CredentialBindingValue; targetScope?: string }> = [];
  if (oauth.connection) {
    bindings.push({
      slot: MCP_OAUTH_CONNECTION_SLOT,
      value: httpCredentialInputToBindingValue(oauth.connection),
    });
  }
  if (oauth.clientId) {
    bindings.push({
      slot: MCP_OAUTH_CLIENT_ID_SLOT,
      value: httpCredentialInputToBindingValue(oauth.clientId),
    });
  }
  if (oauth.clientSecret) {
    bindings.push({
      slot: MCP_OAUTH_CLIENT_SECRET_SLOT,
      value: httpCredentialInputToBindingValue(oauth.clientSecret),
    });
  }
  return {
    auth: {
      kind: "oauth2",
      connectionSlot: MCP_OAUTH_CONNECTION_SLOT,
      ...(oauth.clientId ? { clientIdSlot: MCP_OAUTH_CLIENT_ID_SLOT } : {}),
      ...(oauth.clientSecret ? { clientSecretSlot: MCP_OAUTH_CLIENT_SECRET_SLOT } : {}),
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

const credentialInputMapToConfigValues = (
  values: Record<string, McpConfiguredValueInputType | McpCredentialInput> | undefined,
): Record<string, ConfigHeaderValue> | undefined => {
  if (!values) return undefined;
  const out: Record<string, ConfigHeaderValue> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") {
      out[name] = value;
      continue;
    }
    if (value.kind === "secret" && "secretId" in value) {
      out[name] = headerToConfigValue({ secretId: value.secretId, prefix: value.prefix });
      continue;
    }
    if (value.kind === "text") {
      out[name] = value.prefix ? `${value.prefix}${value.text}` : value.text;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
): Effect.Effect<Record<string, string> | undefined, McpAuthRequiredError | StorageFailure> =>
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
        const secretBinding = binding.value;
        const secret = yield* ctx.secrets.getAtScope(secretBinding.secretId, binding.scopeId).pipe(
          Effect.catchTag("SecretOwnedByConnectionError", () =>
            Effect.fail(
              new McpAuthRequiredError({
                code: "credential_secret_missing",
                sourceId: params.sourceId,
                sourceScope: params.sourceScope,
                credentialKind: "secret",
                credentialLabel: name,
                slotKey: value.slot,
                secretId: String(secretBinding.secretId),
                message: `Failed to resolve secret for ${params.missingLabel} "${name}"`,
              }),
            ),
          ),
        );
        if (secret === null) {
          return yield* new McpAuthRequiredError({
            code: "credential_secret_missing",
            sourceId: params.sourceId,
            sourceScope: params.sourceScope,
            credentialKind: "secret",
            credentialLabel: name,
            slotKey: value.slot,
            secretId: String(secretBinding.secretId),
            message: `Missing secret "${secretBinding.secretId}" for ${params.missingLabel} "${name}"`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.value.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.value.text}` : binding.value.text;
        continue;
      }
      return yield* new McpAuthRequiredError({
        code: "credential_binding_missing",
        sourceId: params.sourceId,
        sourceScope: params.sourceScope,
        credentialKind: "secret",
        credentialLabel: name,
        slotKey: value.slot,
        message: `Missing binding for ${params.missingLabel} "${name}"`,
      });
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });

const resolveInitialMcpCredentialValueMap = (
  ctx: PluginCtx<McpBindingStore>,
  values: Record<string, ConfiguredMcpCredentialValue>,
  bindings: ReadonlyArray<{ readonly slot: string; readonly value: CredentialBindingValue }>,
  targetScope: string,
  missingLabel: string,
): Effect.Effect<Record<string, string> | undefined, McpConnectionError | StorageFailure> =>
  Effect.gen(function* () {
    const bySlot = new Map(bindings.map((binding) => [binding.slot, binding.value] as const));
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string") {
        resolved[name] = value;
        continue;
      }
      const binding = bySlot.get(value.slot);
      if (binding?.kind === "secret") {
        const secret = yield* ctx.secrets
          .getAtScope(binding.secretId, binding.secretScopeId ?? ScopeId.make(targetScope))
          .pipe(
            Effect.catchTag("SecretOwnedByConnectionError", () =>
              Effect.fail(
                new McpConnectionError({
                  transport: "remote",
                  message: `Failed to resolve secret for ${missingLabel} "${name}"`,
                }),
              ),
            ),
          );
        if (secret === null) {
          return yield* new McpConnectionError({
            transport: "remote",
            message: `Missing secret "${binding.secretId}" for ${missingLabel} "${name}"`,
          });
        }
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        continue;
      }
      if (binding?.kind === "text") {
        resolved[name] = value.prefix ? `${value.prefix}${binding.text}` : binding.text;
      }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  });

const resolveInitialMcpOauthProvider = (
  ctx: PluginCtx<McpBindingStore>,
  bindings: ReadonlyArray<{ readonly slot: string; readonly value: CredentialBindingValue }>,
  targetScope: string,
): Effect.Effect<OAuthClientProvider | undefined, McpConnectionError | StorageFailure> =>
  Effect.gen(function* () {
    const connection = bindings.find(
      (binding) =>
        binding.slot === MCP_OAUTH_CONNECTION_SLOT && binding.value.kind === "connection",
    );
    if (!connection || connection.value.kind !== "connection") return undefined;
    const connectionId = connection.value.connectionId;
    const accessToken = yield* ctx.connections
      .accessTokenAtScope(connectionId, ScopeId.make(targetScope))
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

const resolveMcpHeaderAuth = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  auth: McpConnectionAuth,
): Effect.Effect<Record<string, string>, McpAuthRequiredError | StorageFailure> =>
  Effect.gen(function* () {
    if (auth.kind !== "header") return {};
    const binding = yield* resolveMcpSourceBinding(ctx, sourceId, sourceScope, auth.secretSlot);
    if (binding?.value.kind === "secret") {
      const secretBinding = binding.value;
      const secret = yield* ctx.secrets.getAtScope(secretBinding.secretId, binding.scopeId).pipe(
        Effect.catchTag("SecretOwnedByConnectionError", () =>
          Effect.fail(
            new McpAuthRequiredError({
              code: "credential_secret_missing",
              sourceId,
              sourceScope,
              credentialKind: "secret",
              credentialLabel: auth.headerName,
              slotKey: auth.secretSlot,
              secretId: String(secretBinding.secretId),
              message: `Failed to resolve header auth binding "${auth.secretSlot}"`,
            }),
          ),
        ),
      );
      if (secret === null) {
        return yield* new McpAuthRequiredError({
          code: "credential_secret_missing",
          sourceId,
          sourceScope,
          credentialKind: "secret",
          credentialLabel: auth.headerName,
          slotKey: auth.secretSlot,
          secretId: String(secretBinding.secretId),
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
    return yield* new McpAuthRequiredError({
      code: "credential_binding_missing",
      sourceId,
      sourceScope,
      credentialKind: "secret",
      credentialLabel: auth.headerName,
      slotKey: auth.secretSlot,
      message: `Missing header auth binding "${auth.secretSlot}"`,
    });
  });

const resolveMcpStoredOauthProvider = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  sourceScope: string,
  auth: McpConnectionAuth,
): Effect.Effect<OAuthClientProvider | undefined, McpAuthRequiredError | StorageFailure> =>
  Effect.gen(function* () {
    if (auth.kind !== "oauth2") return undefined;
    const binding = yield* resolveMcpSourceBinding(ctx, sourceId, sourceScope, auth.connectionSlot);
    if (binding?.value.kind !== "connection") {
      return yield* new McpAuthRequiredError({
        code: "oauth_connection_missing",
        sourceId,
        sourceScope,
        credentialKind: "connection",
        credentialLabel: "OAuth sign-in",
        slotKey: auth.connectionSlot,
        message: `Missing OAuth connection binding for MCP source "${sourceId}"`,
      });
    }
    const connectionId = binding.value.connectionId;
    const accessToken = yield* ctx.connections
      .accessTokenAtScope(connectionId, binding.scopeId)
      .pipe(
        Effect.catchTags({
          ConnectionReauthRequiredError: ({ message, connectionId: failedConnectionId }) =>
            Effect.fail(
              new McpAuthRequiredError({
                code: "oauth_reauth_required",
                sourceId,
                sourceScope,
                credentialKind: "oauth",
                credentialLabel: "OAuth sign-in",
                slotKey: auth.connectionSlot,
                connectionId: String(failedConnectionId),
                message: `OAuth connection "${failedConnectionId}" needs re-authentication: ${message}`,
              }),
            ),
          ConnectionNotFoundError: ({ connectionId: failedConnectionId }) =>
            Effect.fail(
              new McpAuthRequiredError({
                code: "oauth_connection_missing",
                sourceId,
                sourceScope,
                credentialKind: "connection",
                credentialLabel: "OAuth sign-in",
                slotKey: auth.connectionSlot,
                connectionId: String(failedConnectionId),
                message: `OAuth connection "${failedConnectionId}" was not found for MCP source "${sourceId}"`,
              }),
            ),
          ConnectionProviderNotRegisteredError: ({ provider }) =>
            Effect.fail(
              new McpAuthRequiredError({
                code: "oauth_connection_failed",
                sourceId,
                sourceScope,
                credentialKind: "oauth",
                credentialLabel: "OAuth sign-in",
                slotKey: auth.connectionSlot,
                connectionId: String(connectionId),
                message: `OAuth provider "${provider}" is not registered`,
              }),
            ),
          ConnectionRefreshNotSupportedError: ({ provider, connectionId: failedConnectionId }) =>
            Effect.fail(
              new McpAuthRequiredError({
                code: "oauth_connection_failed",
                sourceId,
                sourceScope,
                credentialKind: "oauth",
                credentialLabel: "OAuth sign-in",
                slotKey: auth.connectionSlot,
                connectionId: String(failedConnectionId),
                message: `OAuth provider "${provider}" cannot refresh connection "${failedConnectionId}"`,
              }),
            ),
          ConnectionRefreshError: ({ message, connectionId: failedConnectionId }) =>
            Effect.fail(
              new McpAuthRequiredError({
                code: "oauth_connection_failed",
                sourceId,
                sourceScope,
                credentialKind: "oauth",
                credentialLabel: "OAuth sign-in",
                slotKey: auth.connectionSlot,
                connectionId: String(failedConnectionId),
                message: `OAuth connection "${failedConnectionId}" refresh failed: ${message}`,
              }),
            ),
        }),
      );
    return makeOAuthProvider(accessToken);
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
): Effect.Effect<ConnectorInput, McpAuthRequiredError | McpConnectionError | StorageFailure> => {
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
  readonly connectionCache: ScopedCache.ScopedCache<
    string,
    McpConnection,
    McpAuthRequiredError | McpConnectionError
  >;
  readonly pendingConnectors: Map<
    string,
    Effect.Effect<McpConnection, McpAuthRequiredError | McpConnectionError>
  >;
  readonly cacheScope: Scope.Closeable;
}

const makeRuntime = (): Effect.Effect<McpRuntime, never> =>
  Effect.gen(function* () {
    const cacheScope = yield* Scope.make();
    const pendingConnectors = new Map<
      string,
      Effect.Effect<McpConnection, McpAuthRequiredError | McpConnectionError>
    >();
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

const authToConfig = (auth: McpConnectionAuthInput | undefined): McpAuthConfig | undefined => {
  if (!auth) return undefined;
  if ("kind" in auth) return { kind: "none" };
  const connection = auth.oauth2?.connection;
  if (!connection || typeof connection === "string" || connection.kind !== "connection") {
    return undefined;
  }
  return {
    kind: "oauth2",
    connectionId: connection.connectionId,
  };
};

// ---------------------------------------------------------------------------
// Storage-form → input-form reconstruction
//
// `toMcpConfigEntry` consumes the `McpSourceConfig` *input* shape — the
// configure form, which `authToConfig` and `credentialInputMapToConfigValues`
// know how to render into the file. Stored remote data
// is in slot form (`secretSlot`, `{kind: "binding", slot}`), so writing
// the file from a stored row needs the slot → secret/connection lookups
// realized first. Walk the source's `credential_binding` rows and rebuild
// the input shape; any slot whose binding is missing is dropped.
// ---------------------------------------------------------------------------

const toCredentialInput = (
  bySlot: Map<string, CredentialBindingValue>,
  configured: ConfiguredMcpCredentialValue,
): McpCredentialInput | undefined => {
  if (typeof configured === "string") return configured;
  const value = bySlot.get(configured.slot);
  if (!value) return undefined;
  if (value.kind === "secret") {
    return {
      kind: "secret",
      secretId: value.secretId,
      ...(value.secretScopeId ? { secretScope: value.secretScopeId } : {}),
      ...(configured.prefix ? { prefix: configured.prefix } : {}),
    };
  }
  if (value.kind === "text") return value.text;
  // headers / queryParams cannot reference connections — only auth can.
  return undefined;
};

const toCredentialInputMap = (
  bySlot: Map<string, CredentialBindingValue>,
  values: Record<string, ConfiguredMcpCredentialValue> | undefined,
): Record<string, McpCredentialInput> | undefined => {
  if (!values) return undefined;
  const out: Record<string, McpCredentialInput> = {};
  for (const [name, configured] of Object.entries(values)) {
    const input = toCredentialInput(bySlot, configured);
    if (input !== undefined) out[name] = input;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const toAuthInput = (
  bySlot: Map<string, CredentialBindingValue>,
  auth: McpConnectionAuth,
): McpConnectionAuthInput | undefined => {
  if (auth.kind === "none") return { kind: "none" };
  if (auth.kind === "header") {
    const value = bySlot.get(auth.secretSlot);
    if (value?.kind !== "secret") return undefined;
    return {
      kind: "none",
    };
  }
  const connection = bySlot.get(auth.connectionSlot);
  return {
    oauth2: {
      ...(connection?.kind === "connection"
        ? { connection: { kind: "connection" as const, connectionId: connection.connectionId } }
        : {}),
    },
  };
};

const inputFormFromStored = (
  bindings: ReadonlyArray<CredentialBindingRef>,
  stored: McpStoredSourceData,
  scope: string,
  sourceName: string,
  namespace: string,
): McpConfigFileSourceConfig => {
  if (stored.transport === "stdio") {
    return {
      transport: "stdio",
      scope,
      name: sourceName,
      namespace,
      command: stored.command,
      args: stored.args ? [...stored.args] : undefined,
      env: stored.env,
      cwd: stored.cwd,
    };
  }
  const bySlot = new Map(bindings.map((b) => [b.slotKey, b.value] as const));
  return {
    transport: "remote",
    scope,
    name: sourceName,
    namespace,
    endpoint: stored.endpoint,
    remoteTransport: stored.remoteTransport,
    headers: toCredentialInputMap(bySlot, stored.headers),
    queryParams: toCredentialInputMap(bySlot, stored.queryParams),
    auth: toAuthInput(bySlot, stored.auth),
  };
};

const toMcpConfigEntry = (
  namespace: string,
  sourceName: string,
  config: McpConfigFileSourceConfig,
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
    queryParams: credentialInputMapToConfigValues(config.queryParams),
    headers: credentialInputMapToConfigValues(config.headers),
    namespace,
    auth: authToConfig(config.auth),
  };
  return entry;
};

const refreshSourceInternal = (
  ctx: PluginCtx<McpBindingStore>,
  sourceId: string,
  scope: string,
  allowStdio: boolean,
) =>
  Effect.gen(function* () {
    const sd = yield* ctx.storage.getSourceConfig(sourceId, scope).pipe(
      Effect.withSpan("mcp.plugin.load_source_config", {
        attributes: { "mcp.source.namespace": sourceId },
      }),
    );
    if (!sd) {
      return yield* new McpConnectionError({
        transport: "remote",
        message: `No stored config for MCP source "${sourceId}"`,
      });
    }

    const ci = yield* resolveConnectorInput(sourceId, scope, sd, ctx, allowStdio).pipe(
      Effect.catchTag("McpAuthRequiredError", ({ message }) =>
        Effect.fail(new McpConnectionError({ transport: sd.transport, message })),
      ),
      Effect.withSpan("mcp.plugin.resolve_connector", {
        attributes: {
          "mcp.source.namespace": sourceId,
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
        attributes: { "mcp.source.namespace": sourceId },
      }),
    );

    const existing = yield* ctx.storage.getSource(sourceId, scope);
    const sourceName = manifest.server?.name ?? existing?.name ?? sourceId;

    yield* ctx
      .transaction(
        Effect.gen(function* () {
          yield* ctx.storage.removeBindingsByNamespace(sourceId, scope);
          yield* ctx.core.sources.unregister({ id: sourceId, targetScope: scope });

          yield* ctx.storage.putBindings(
            sourceId,
            scope,
            manifest.tools.map((e) => ({
              toolId: `${sourceId}.${e.toolId}`,
              binding: toBinding(e),
            })),
          );
          yield* ctx.core.sources.register({
            id: sourceId,
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
              outputSchema: mcpCallToolResultOutputSchema(e.outputSchema),
            })),
          });
        }),
      )
      .pipe(
        Effect.withSpan("mcp.plugin.persist_source", {
          attributes: {
            "mcp.source.namespace": sourceId,
            "mcp.source.tool_count": manifest.tools.length,
          },
        }),
      );

    return { toolCount: manifest.tools.length };
  }).pipe(
    Effect.withSpan("mcp.plugin.refresh_source", {
      attributes: { "mcp.source.namespace": sourceId },
    }),
  );

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
    sourcePresets: allowStdio
      ? mcpPresets.map((preset) => ({
          ...preset,
          transport: "transport" in preset ? preset.transport : "remote",
        }))
      : mcpPresets
          .filter((preset) => !("transport" in preset && preset.transport === "stdio"))
          .map((preset) => ({
            ...preset,
            transport: "remote" as const,
          })),
    // Surfaced to the client bundle via the Vite plugin (see
    // `@executor-js/vite-plugin`). The MCP `./client` factory reads
    // `allowStdio` and gates the stdio tab + presets in AddMcpSource —
    // so the server's `dangerouslyAllowStdioMCP` flag is the single
    // source of truth for both runtime and UI.
    clientConfig: { allowStdio },
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
                  headers: canonicalizeConfiguredValueMap(config.headers, mcpHeaderSlot),
                  queryParams: canonicalizeConfiguredValueMap(
                    config.queryParams,
                    mcpQueryParamSlot,
                  ),
                }
              : null;
          const initialRemote =
            config.transport === "remote" && config.credentials
              ? {
                  scope: config.credentials.scope,
                  headers:
                    config.credentials.headers !== undefined
                      ? canonicalizeCredentialMap(config.credentials.headers, mcpHeaderSlot)
                      : null,
                  queryParams:
                    config.credentials.queryParams !== undefined
                      ? canonicalizeCredentialMap(config.credentials.queryParams, mcpQueryParamSlot)
                      : null,
                  auth:
                    config.credentials.auth !== undefined
                      ? canonicalizeAuth(config.credentials.auth)
                      : null,
                }
              : null;
          const remoteAuth =
            config.transport === "remote"
              ? config.oauth2
                ? authFromOAuth2Source(config.oauth2)
                : (initialRemote?.auth?.auth ?? ({ kind: "none" } as McpConnectionAuth))
              : null;
          const remoteCredentials =
            canonicalRemote && remoteAuth
              ? {
                  headers: canonicalRemote.headers,
                  queryParams: canonicalRemote.queryParams,
                  auth: remoteAuth,
                }
              : undefined;
          const initialBindings = [
            ...(initialRemote?.headers?.bindings ?? []),
            ...(initialRemote?.queryParams?.bindings ?? []),
            ...(initialRemote?.auth?.bindings ?? []),
          ];
          if (initialRemote && initialBindings.length > 0) {
            yield* validateMcpBindingTarget(ctx, {
              sourceId: namespace,
              sourceScope: config.scope,
              targetScope: initialRemote.scope,
            });
          }
          const sd = toStoredSourceData(config, remoteCredentials);

          // Stdio sources are gated — a resolver failure there is a
          // config error the admin must fix before the source makes
          // sense to persist at all. For remote sources we defer the
          // resolver failure: auth might not be ready yet (oauth2
          // connection awaiting per-user sign-in, header secret
          // awaiting upload) but the source row should still land so
          // it shows up in the list and exposes a Sign-in affordance.
          const initialQueryParams =
            initialRemote?.queryParams &&
            (yield* resolveInitialMcpCredentialValueMap(
              ctx,
              canonicalRemote?.queryParams ?? initialRemote.queryParams.values,
              initialRemote.queryParams.bindings,
              initialRemote.scope,
              "query parameter",
            ));
          const initialHeaders =
            initialRemote?.headers &&
            (yield* resolveInitialMcpCredentialValueMap(
              ctx,
              canonicalRemote?.headers ?? initialRemote.headers.values,
              initialRemote.headers.bindings,
              initialRemote.scope,
              "header",
            ));
          const remoteQueryParams = {
            ...(config.transport === "remote"
              ? (resolveConfiguredValueMap(config.queryParams) ?? {})
              : {}),
            ...(initialQueryParams || {}),
          };
          const remoteHeaders = {
            ...(config.transport === "remote"
              ? (resolveConfiguredValueMap(config.headers) ?? {})
              : {}),
            ...(initialHeaders || {}),
          };
          const initialAuthProvider =
            initialRemote?.auth !== null && initialRemote?.auth !== undefined
              ? yield* resolveInitialMcpOauthProvider(
                  ctx,
                  initialRemote.auth.bindings,
                  initialRemote.scope,
                )
              : undefined;
          const resolved: Result.Result<
            ConnectorInput,
            McpAuthRequiredError | McpConnectionError | StorageFailure
          > =
            config.transport === "remote"
              ? Result.succeed({
                  transport: "remote" as const,
                  endpoint: config.endpoint,
                  remoteTransport: config.remoteTransport ?? "auto",
                  queryParams:
                    Object.keys(remoteQueryParams).length > 0 ? remoteQueryParams : undefined,
                  headers: Object.keys(remoteHeaders).length > 0 ? remoteHeaders : undefined,
                  authProvider: initialAuthProvider,
                })
              : yield* resolveConnectorInput(namespace, config.scope, sd, ctx, allowStdio).pipe(
                  Effect.result,
                  Effect.withSpan("mcp.plugin.resolve_connector", {
                    attributes: {
                      "mcp.source.namespace": namespace,
                      "mcp.source.transport": sd.transport,
                    },
                  }),
                );

          if (Result.isFailure(resolved) && sd.transport === "stdio") {
            if (Predicate.isTagged(resolved.failure, "McpAuthRequiredError")) {
              return yield* new McpConnectionError({
                transport: sd.transport,
                message: resolved.failure.message,
              });
            }
            return yield* Effect.fail(resolved.failure);
          }

          // Try discovery only if we have a live connector input.
          // Otherwise fall straight through to the persist step with
          // an empty manifest and surface the resolver failure to
          // the caller at the end.
          const discovery: Result.Result<
            McpToolManifest,
            McpAuthRequiredError | McpToolDiscoveryError | McpConnectionError | StorageFailure
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
                    outputSchema: mcpCallToolResultOutputSchema(e.outputSchema),
                  })),
                });
                if (initialRemote && initialBindings.length > 0) {
                  yield* ctx.credentialBindings.replaceForSource({
                    targetScope: ScopeId.make(initialRemote.scope),
                    pluginId: MCP_PLUGIN_ID,
                    sourceId: namespace,
                    sourceScope: ScopeId.make(config.scope),
                    slotPrefixes: [
                      ...(initialRemote.headers !== null ? ["header:"] : []),
                      ...(initialRemote.queryParams !== null ? ["query_param:"] : []),
                      ...(initialRemote.auth !== null ? ["auth:"] : []),
                    ],
                    bindings: initialBindings.map((binding) => ({
                      slotKey: binding.slot,
                      value: binding.value,
                    })),
                  });
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
            if (Predicate.isTagged(discovery.failure, "McpAuthRequiredError")) {
              return yield* new McpConnectionError({
                transport: sd.transport,
                message: discovery.failure.message,
              });
            }
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
        refreshSourceInternal(ctx, namespace, scope, allowStdio);

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
      };
    },

    sourceConfigure: {
      type: "mcp",
      schema: McpConfigureSourcePayloadSchema,
      configure: ({ ctx, sourceId, sourceScope, targetScope, config }) =>
        Effect.gen(function* () {
          const input = config as Omit<McpConfigureSourceInput, "scope">;
          const existing = yield* ctx.storage.getSource(sourceId, sourceScope);
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
          if (directBindings.length > 0) {
            yield* validateMcpBindingTarget(ctx, {
              sourceId,
              sourceScope,
              targetScope,
            });
          }

          const updatedConfig: McpStoredSourceData = {
            ...existing.config,
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

          const sourceName = input.name?.trim() || existing.name;
          yield* ctx.transaction(
            Effect.gen(function* () {
              yield* ctx.storage.putSource({
                namespace: sourceId,
                scope: sourceScope,
                name: sourceName,
                config: updatedConfig,
              });
              if (affectedPrefixes.length > 0 || directBindings.length > 0) {
                yield* ctx.credentialBindings.replaceForSource({
                  targetScope: ScopeId.make(targetScope),
                  pluginId: MCP_PLUGIN_ID,
                  sourceId,
                  sourceScope: ScopeId.make(sourceScope),
                  slotPrefixes: affectedPrefixes,
                  bindings: directBindings.map((binding) => ({
                    slotKey: binding.slot,
                    value: binding.value,
                  })),
                });
              }
            }),
          );
          if (options?.configFile) {
            const bindings = yield* ctx.credentialBindings.listForSource({
              pluginId: MCP_PLUGIN_ID,
              sourceId,
              sourceScope: ScopeId.make(sourceScope),
            });
            const inputForm = inputFormFromStored(
              bindings,
              updatedConfig,
              sourceScope,
              sourceName,
              sourceId,
            );
            yield* options.configFile
              .upsertSource(toMcpConfigEntry(sourceId, sourceName, inputForm))
              .pipe(Effect.withSpan("mcp.plugin.config_file.upsert"));
          }
        }),
    },

    staticSources: (self) => [
      {
        id: "mcp",
        kind: "executor",
        name: "MCP",
        tools: [
          tool({
            name: "probeEndpoint",
            description:
              "Probe a remote MCP endpoint before adding it. If the result requires OAuth, call `executor.coreTools.oauth.probe` and `executor.coreTools.oauth.start` with `credentialScope` set to the user's chosen personal or organization credential scope first, then pass the resulting connection through `addSource` credentials or `mcp.configureSource`.",
            inputSchema: McpProbeEndpointInputStandardSchema,
            outputSchema: McpProbeEndpointOutputStandardSchema,
            execute: (input) =>
              self.probeEndpoint(input).pipe(
                Effect.map(ToolResult.ok),
                Effect.catchTag("McpConnectionError", ({ message, transport }) =>
                  Effect.succeed(mcpToolFailure("mcp_connection_failed", message, { transport })),
                ),
              ),
          }),
          tool({
            name: "getSource",
            description:
              "Inspect an existing MCP source, including transport, endpoint/command, auth mode, configured headers/query params, and credential slots. Use this before repairing an existing source with `mcp.configureSource`, `secrets.create`, or `oauth.start`.",
            inputSchema: McpGetSourceInputStandardSchema,
            outputSchema: McpGetSourceOutputStandardSchema,
            execute: (input, { ctx }) => {
              const args = input as typeof McpGetSourceInputSchema.Type;
              return Effect.map(
                self.getSource(args.namespace, resolveStaticScopeInput(ctx, args.scope)),
                (source) => ToolResult.ok({ source }),
              );
            },
          }),
          tool({
            name: "addSource",
            description:
              "Add an MCP source and register its tools. Executor chooses the source install scope (local scope locally, organization scope in cloud) and returns it as `source`. For remote OAuth-protected servers, first use `probeEndpoint` and the core OAuth browser handoff (`oauth.probe`, `oauth.start` with the user's chosen `credentialScope`), then bind the completed connection with `mcp.configureSource` if needed. For header/API-key auth, first call `secrets.create` at the user's chosen credential scope so the value is entered in the browser, then pass the secret reference in `credentials`. Remote sources are still saved if discovery fails; inspect the returned `discovery` field and use `sources.refresh` after credentials or network access are fixed.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add an MCP source",
            },
            inputSchema: McpAddSourceInputStandardSchema,
            outputSchema: McpAddSourceOutputStandardSchema,
            execute: (rawInput, { ctx }) => {
              const input = rawInput as typeof McpAddSourceInputSchema.Type;
              const sourceScope = defaultSourceInstallScopeId(ctx.scopes);
              if (sourceScope === null) {
                return Effect.succeed(
                  mcpToolFailure(
                    "source_scope_unavailable",
                    "Cannot add an MCP source because this executor has no source install scope.",
                  ),
                );
              }
              const normalizedInput = {
                ...input,
                scope: sourceScope,
              } as McpSourceConfig;
              const added = self.addSource(normalizedInput).pipe(
                Effect.map((result) =>
                  ToolResult.ok({
                    ...result,
                    source: { id: result.namespace, scope: sourceScope },
                    discovery: { status: "ok" },
                  }),
                ),
              );
              if (normalizedInput.transport !== "remote") return added;

              const savedWithDiscoveryFailure = (failure: {
                readonly message: string;
                readonly stage?: string;
              }) =>
                Effect.succeed(
                  ToolResult.ok({
                    namespace:
                      normalizedInput.namespace ??
                      deriveMcpNamespace({
                        name: normalizedInput.name,
                        endpoint: normalizedInput.endpoint,
                      }),
                    source: {
                      id:
                        normalizedInput.namespace ??
                        deriveMcpNamespace({
                          name: normalizedInput.name,
                          endpoint: normalizedInput.endpoint,
                        }),
                      scope: sourceScope,
                    },
                    toolCount: 0,
                    discovery: {
                      status: "failed" as const,
                      message: failure.message,
                      ...(failure.stage ? { stage: failure.stage } : {}),
                    },
                  }),
                );

              return added.pipe(
                Effect.catchTags({
                  McpToolDiscoveryError: savedWithDiscoveryFailure,
                  McpConnectionError: ({ message }) =>
                    Effect.succeed(
                      ToolResult.ok({
                        namespace:
                          normalizedInput.namespace ??
                          deriveMcpNamespace({
                            name: normalizedInput.name,
                            endpoint: normalizedInput.endpoint,
                          }),
                        source: {
                          id:
                            normalizedInput.namespace ??
                            deriveMcpNamespace({
                              name: normalizedInput.name,
                              endpoint: normalizedInput.endpoint,
                            }),
                          scope: sourceScope,
                        },
                        toolCount: 0,
                        discovery: {
                          status: "failed" as const,
                          message,
                        },
                      }),
                    ),
                }),
              );
            },
          }),
          tool({
            name: "configureSource",
            description:
              'Configure an existing remote MCP source with concrete fields. Use `source` returned by `mcp.addSource` or `sources.list`. The top-level `scope` is the credential target scope for bindings; in cloud, choose the user or organization credential scope deliberately. Pass secret refs as `{kind:"secret", secretId}` and OAuth connections as `{kind:"connection", connectionId}`.',
            annotations: {
              requiresApproval: true,
              approvalDescription: "Configure an MCP source",
            },
            inputSchema: McpStaticConfigureSourceInputStandardSchema,
            outputSchema: McpStaticConfigureSourceOutputStandardSchema,
            execute: (rawInput, { ctx }) =>
              Effect.gen(function* () {
                const { source, ...config } =
                  rawInput as typeof McpStaticConfigureSourceInputSchema.Type;
                const sourceScope = resolveStaticScopeInput(ctx, source.scope);
                const targetScope = resolveStaticScopeInput(ctx, config.scope);
                yield* ctx.core.sources.configure({
                  source: { id: source.id, scope: sourceScope },
                  scope: targetScope,
                  type: "mcp",
                  config: {
                    ...(config.name !== undefined ? { name: config.name } : {}),
                    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
                    ...(config.headers !== undefined ? { headers: config.headers } : {}),
                    ...(config.queryParams !== undefined
                      ? { queryParams: config.queryParams }
                      : {}),
                    ...(config.auth !== undefined ? { auth: config.auth } : {}),
                  },
                });
                return ToolResult.ok({ configured: true });
              }),
          }),
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args, elicit }) =>
      Effect.gen(function* () {
        const runtime = yield* ensureRuntime();

        // toolRow.scope_id is the resolved owning scope of the tool
        // (innermost-wins from the executor's stack). The matching
        // MCP binding + source plugin-storage rows live at the same scope, so
        // pin every store lookup to it instead of relying on stack-wide
        // scope fall-through.
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

        const raw = yield* invokeMcpTool({
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

        const envelope = Option.getOrUndefined(decodeMcpToolCallEnvelope(raw));
        if (envelope?.isError === true) {
          return ToolResult.fail({
            code: "mcp_tool_error",
            message: extractMcpErrorMessage(envelope.content),
            details: { content: envelope.content },
          });
        }
        return ToolResult.ok(raw);
      }).pipe(
        Effect.catchTag("McpAuthRequiredError", (error) =>
          Effect.succeed(mcpAuthToolFailure(error)),
        ),
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
          return SourceDetectionResult.make({
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
          return SourceDetectionResult.make({
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
          return SourceDetectionResult.make({
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
    // row rather than collapsing onto whichever visible row would otherwise
    // win first.
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
        if (options?.configFile) {
          yield* options.configFile.removeSource(sourceId);
        }
      }),

    usagesForSecret: () => Effect.succeed([]),

    usagesForConnection: () => Effect.succeed([]),

    refreshSource: ({ ctx, sourceId, scope }) =>
      refreshSourceInternal(ctx, sourceId, scope, allowStdio).pipe(Effect.asVoid),

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
  };
  // HTTP transport (routes/handlers/extensionService) is layered on by
  // the api-aware factory in `@executor-js/plugin-mcp/api`. Hosts that
  // want the HTTP surface import the plugin from there; SDK-only
  // consumers stay on this entry and avoid the server-only deps.
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
}
