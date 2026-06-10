import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  authToolFailure,
  definePlugin,
  IntegrationAlreadyExistsError,
  IntegrationSlug,
  mergeAuthTemplates,
  OAuthClientSlug,
  tool,
  ToolResult,
  type AuthMethodDescriptor,
  type Integration,
  type IntegrationConfig,
  type IntegrationRecord,
  type OAuthClientSummary,
  type Owner,
  type PluginCtx,
  type StaticToolSchema,
  type StorageFailure,
  type ToolAnnotations,
  type ToolDef,
  ToolName,
} from "@executor-js/sdk";

import {
  TOKEN_VARIABLE,
  describeApiKeyAuthMethod,
  describeNoneAuthMethod,
  renderAuthPlacements,
  requiredPlacementVariables,
} from "@executor-js/sdk/http-auth";

import { createMcpConnector, type ConnectorInput, type McpConnector } from "./connection";
import { discoverTools } from "./discover";
import { McpConnectionError, McpToolDiscoveryError } from "./errors";
import { invokeMcpTool } from "./invoke";
import { deriveMcpNamespace, type McpToolManifestEntry } from "./manifest";
import { mcpPresets } from "./presets";
import { probeMcpEndpointShape, type McpShapeProbeResult } from "./probe-shape";
import {
  McpAuthMethodInput,
  McpAuthShorthand,
  McpRemoteTransport,
  type McpAuthMethod,
  type McpToolAnnotations,
  expandMcpAuthMethodInputs,
  mcpAuthMethodFromShorthand,
  normalizeMcpAuthMethods,
  parseMcpIntegrationConfig,
  type McpIntegrationConfig as McpIntegrationConfigType,
  type McpRemoteIntegrationConfig,
  type McpStdioIntegrationConfig,
} from "./types";

const MCP_PLUGIN_ID = "mcp" as const;

const legacyOAuthClientSlugCandidate = (value: string): string | null => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
};

const legacyOAuthClientSlugCandidates = (
  slug: string,
  integration: (Integration & { readonly config: IntegrationConfig }) | null,
): ReadonlySet<string> => {
  const candidates = new Set<string>();
  const fromSlug = legacyOAuthClientSlugCandidate(slug);
  if (fromSlug) candidates.add(fromSlug);
  const fromDescription =
    integration == null ? null : legacyOAuthClientSlugCandidate(integration.description);
  if (fromDescription) candidates.add(fromDescription);
  return candidates;
};

const oauthClientKey = (owner: Owner, slug: OAuthClientSlug): string => `${owner}:${String(slug)}`;

const legacyMcpClientMatches = (
  client: OAuthClientSummary,
  candidates: ReadonlySet<string>,
  config: McpIntegrationConfigType | null,
): boolean => {
  if (!candidates.has(String(client.slug))) return false;
  if (
    !config ||
    config.transport !== "remote" ||
    !config.authenticationTemplate.some((method: McpAuthMethod) => method.kind === "oauth2")
  ) {
    return false;
  }
  return client.grant === "authorization_code" && (client.resource ?? null) === config.endpoint;
};

// ---------------------------------------------------------------------------
// Tool annotations carry an `mcp` envelope alongside the executor's policy
// hints. The executor persists `ToolDef.annotations` verbatim into the tool
// row's JSON column, so the real MCP tool name + upstream annotations survive
// to `invokeTool` / `resolveAnnotations` with no plugin-side store (resolveTools
// has no ctx to write one anyway). The envelope is opaque to core.
// ---------------------------------------------------------------------------

interface McpToolStamp {
  readonly toolName: string;
  readonly upstream?: McpToolAnnotations;
}

type StampedAnnotations = ToolAnnotations & { readonly mcp: McpToolStamp };

const McpStampSchema = Schema.Struct({
  toolName: Schema.String,
  upstream: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      readOnlyHint: Schema.optional(Schema.Boolean),
      destructiveHint: Schema.optional(Schema.Boolean),
      idempotentHint: Schema.optional(Schema.Boolean),
      openWorldHint: Schema.optional(Schema.Boolean),
    }),
  ),
});
const AnnotationsWithStamp = Schema.Struct({ mcp: McpStampSchema });
const decodeStamp = Schema.decodeUnknownOption(AnnotationsWithStamp);

const readStamp = (annotations: unknown): McpToolStamp | null =>
  Option.match(decodeStamp(annotations), {
    onNone: () => null,
    onSome: (decoded) => decoded.mcp,
  });

// ---------------------------------------------------------------------------
// Extension input shapes — `addServer` registers an MCP integration. A
// connection (the credential) is then created against it via
// `executor.connections.create` / `oauth.start`.
// ---------------------------------------------------------------------------

const McpRemoteServerInputSchema = Schema.Struct({
  transport: Schema.optional(Schema.Literal("remote")),
  name: Schema.String,
  endpoint: Schema.String,
  remoteTransport: Schema.optional(McpRemoteTransport),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  slug: Schema.optional(Schema.String),
  /** Declared auth methods a connection can be applied through. */
  authenticationTemplate: Schema.optional(Schema.Array(McpAuthMethodInput)),
  /** Single-method shorthand (legacy callers). Ignored when
   *  `authenticationTemplate` is present. Defaults to none. */
  auth: Schema.optional(McpAuthShorthand),
});

const McpStdioServerInputSchema = Schema.Struct({
  transport: Schema.Literal("stdio"),
  name: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});

const McpAddServerInputSchema = Schema.Union([
  McpRemoteServerInputSchema,
  McpStdioServerInputSchema,
]);

const McpAddServerOutputSchema = Schema.Struct({
  slug: Schema.String,
});

/** Input for the custom-method-create flow. `merge` (default) appends onto the
 *  integration's existing `authenticationTemplate`; `replace` swaps the whole
 *  declared set. Mirrors the OpenAPI/GraphQL `configureAuth` inputs. */
export const McpConfigureAuthInputSchema = Schema.Struct({
  authenticationTemplate: Schema.Array(McpAuthMethodInput),
  mode: Schema.optional(Schema.Literals(["merge", "replace"])),
});
export type McpConfigureAuthInput = typeof McpConfigureAuthInputSchema.Type;

const McpProbeEndpointInputSchema = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const McpProbeEndpointOutputSchema = Schema.Struct({
  connected: Schema.Boolean,
  requiresAuthentication: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  slug: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
});

// ---------------------------------------------------------------------------
// Extension input/output shapes — `addServer` registers an MCP integration. A
// connection (the credential) is then created against it via
// `executor.connections.create` / `oauth.start`. Types are inferred from the
// schemas above so the wire shape and the TS surface can't drift.
// ---------------------------------------------------------------------------

export type McpRemoteServerInput = typeof McpRemoteServerInputSchema.Type;
export type McpStdioServerInput = typeof McpStdioServerInputSchema.Type;
export type McpServerInput = typeof McpAddServerInputSchema.Type;
export type McpProbeResult = typeof McpProbeEndpointOutputSchema.Type;
export type McpProbeEndpointInput = typeof McpProbeEndpointInputSchema.Type;

const McpGetServerInputSchema = Schema.Struct({
  slug: Schema.String,
});

const McpGetServerOutputSchema = Schema.Struct({
  integration: Schema.NullOr(Schema.Unknown),
});

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const McpAddServerInputStandardSchema = schemaToStaticToolSchema(McpAddServerInputSchema);
const McpAddServerOutputStandardSchema = schemaToStaticToolSchema(McpAddServerOutputSchema);
const McpProbeEndpointInputStandardSchema = schemaToStaticToolSchema(McpProbeEndpointInputSchema);
const McpProbeEndpointOutputStandardSchema = schemaToStaticToolSchema(McpProbeEndpointOutputSchema);
const McpGetServerInputStandardSchema = schemaToStaticToolSchema(McpGetServerInputSchema);
const McpGetServerOutputStandardSchema = schemaToStaticToolSchema(McpGetServerOutputSchema);

const mcpToolFailure = (code: string, message: string, details?: unknown) =>
  ToolResult.fail({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const slugFrom = (slug: string): IntegrationSlug => IntegrationSlug.make(slug);

const normalizeSlug = (input: McpServerInput): string =>
  input.slug ??
  deriveMcpNamespace({
    name: input.name,
    endpoint: input.transport === "stdio" ? undefined : input.endpoint,
    command: input.transport === "stdio" ? input.command : undefined,
  });

const toIntegrationConfig = (input: McpServerInput): McpIntegrationConfigType => {
  if (input.transport === "stdio") {
    return {
      transport: "stdio",
      command: input.command,
      args: input.args ? [...input.args] : undefined,
      env: input.env,
      cwd: input.cwd,
    };
  }
  return {
    transport: "remote",
    endpoint: input.endpoint,
    remoteTransport: input.remoteTransport ?? "auto",
    queryParams: input.queryParams,
    headers: input.headers,
    authenticationTemplate: input.authenticationTemplate
      ? normalizeMcpAuthMethods(input.authenticationTemplate)
      : [mcpAuthMethodFromShorthand(input.auth ?? { kind: "none" })],
  };
};

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

/** Build the executor-facing ToolDef for one discovered MCP tool, stamping the
 *  real MCP tool name + upstream annotations into the persisted annotations so
 *  they survive to invokeTool with no plugin-side store. */
const toToolDef = (entry: McpToolManifestEntry): ToolDef => {
  const destructive = entry.annotations?.destructiveHint === true;
  const stamp: McpToolStamp = {
    toolName: entry.toolName,
    ...(entry.annotations ? { upstream: entry.annotations } : {}),
  };
  const annotations: StampedAnnotations = {
    requiresApproval: destructive,
    ...(destructive ? { approvalDescription: entry.annotations?.title ?? entry.toolName } : {}),
    mcp: stamp,
  };
  return {
    name: ToolName.make(entry.toolId),
    description: entry.description ?? `MCP tool: ${entry.toolName}`,
    inputSchema: entry.inputSchema,
    outputSchema: mcpCallToolResultOutputSchema(entry.outputSchema),
    annotations: annotations as ToolAnnotations,
  };
};

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
 *  used as a low-confidence detection hint when wire-shape detection fails. */
const urlMatchesToken = (url: URL, token: string): boolean => {
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i");
  return re.test(url.hostname) || re.test(url.pathname);
};

/** Translate a non-MCP probe outcome into a message a user can act on.
 *  Exported for tests. */
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

// ---------------------------------------------------------------------------
// MCP-SDK OAuth provider adapter — wraps a pre-resolved access token so the
// transport sends it as a Bearer header. Refresh is core's responsibility
// (the connection row carries the OAuth grant); this adapter never initiates
// a new flow and fails loudly if the SDK tries to.
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

// ---------------------------------------------------------------------------
// Connector input — render the integration config + the connection's resolved
// value through the auth method the connection references (by template slug)
// into a live `ConnectorInput`.
// ---------------------------------------------------------------------------

/** The auth method a connection binds: its `template` slug when it matches a
 *  declared method. Otherwise fall back to the sole declared method — single-
 *  method integrations historically accepted any template slug (rendering was
 *  config-driven), so existing connections keep working. Ambiguity across
 *  several methods renders no auth rather than guessing. */
const selectAuthMethod = (
  config: McpRemoteIntegrationConfig,
  templateSlug: string | null,
): McpAuthMethod | undefined => {
  const methods = config.authenticationTemplate;
  if (templateSlug !== null) {
    const match = methods.find((method: McpAuthMethod) => method.slug === templateSlug);
    if (match) return match;
  }
  return methods.length === 1 ? methods[0] : undefined;
};

const buildConnectorInput = (
  config: McpIntegrationConfigType,
  values: Record<string, string | null>,
  templateSlug: string | null,
  allowStdio: boolean,
): Effect.Effect<ConnectorInput, McpConnectionError> => {
  if (config.transport === "stdio") {
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
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    } satisfies McpStdioIntegrationConfig);
  }

  // Credential placements render OVER the integration's static headers /
  // query params — a same-named static entry is overwritten.
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const queryParams: Record<string, string> = { ...(config.queryParams ?? {}) };
  let authProvider: OAuthClientProvider | undefined;

  const auth = selectAuthMethod(config, templateSlug);
  if (auth?.kind === "apikey") {
    const rendered = renderAuthPlacements(auth.placements, values);
    Object.assign(headers, rendered.headers);
    Object.assign(queryParams, rendered.queryParams);
  } else if (auth?.kind === "oauth2") {
    const token = values[TOKEN_VARIABLE];
    if (token != null) authProvider = makeOAuthProvider(token);
  }

  return Effect.succeed({
    transport: "remote" as const,
    endpoint: config.endpoint,
    remoteTransport: config.remoteTransport ?? "auto",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    authProvider,
  });
};

// ---------------------------------------------------------------------------
// Declared auth methods — project the stored MCP config into the catalog's
// plugin-agnostic `AuthMethodDescriptor[]`, one per declared method. Pure and
// tolerant of a malformed or foreign config blob (returns `[]`). Exported for
// tests.
//
//   none                 → a no-auth method carrying no credential inputs
//   stdio                → []          (no remote connection to configure)
//   apikey               → carried placements (headers / query params) verbatim
//   oauth2               → an oauth method carrying the MCP endpoint to probe
//                          (`discoveryUrl`); endpoints are discovered live at
//                          connect time, so they are NOT pre-resolved here. We
//                          mark `supportsDynamicRegistration: true` because MCP
//                          OAuth servers are expected to support RFC 7591 DCR;
//                          the connect flow probes to confirm and falls back.
// ---------------------------------------------------------------------------

export const describeMcpAuthMethods = (
  record: IntegrationRecord,
): readonly AuthMethodDescriptor[] => {
  const config = parseMcpIntegrationConfig(record.config);
  if (!config || config.transport === "stdio") return [];

  return config.authenticationTemplate.map((method: McpAuthMethod): AuthMethodDescriptor => {
    if (method.kind === "apikey") return describeApiKeyAuthMethod(method);
    if (method.kind === "oauth2") {
      return {
        id: method.slug,
        label: "OAuth",
        kind: "oauth",
        template: method.slug,
        oauth: { discoveryUrl: config.endpoint, supportsDynamicRegistration: true },
      };
    }
    return describeNoneAuthMethod(method.slug);
  });
};

export const describeMcpIntegrationDisplay = (
  record: IntegrationRecord,
): { readonly url?: string } => {
  const config = parseMcpIntegrationConfig(record.config);
  if (!config || config.transport === "stdio") return {};
  return { url: config.endpoint };
};

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface McpPluginOptions {
  /**
   * Allow configuring stdio-transport MCP servers. Off by default.
   *
   * Stdio servers spawn a local subprocess that inherits the parent
   * `process.env`. Only enable for trusted single-user contexts.
   */
  readonly dangerouslyAllowStdioMCP?: boolean;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
}

export const mcpPlugin = definePlugin((options?: McpPluginOptions) => {
  const allowStdio = options?.dangerouslyAllowStdioMCP ?? false;

  const presetEntries = (
    allowStdio
      ? mcpPresets
      : mcpPresets.filter((preset) => !("transport" in preset && preset.transport === "stdio"))
  ).map((preset) => ({
    id: preset.id,
    name: preset.name,
    summary: preset.summary,
    ...("url" in preset && preset.url ? { url: preset.url } : {}),
    ...("endpoint" in preset && preset.endpoint ? { endpoint: preset.endpoint } : {}),
    ...(preset.icon ? { icon: preset.icon } : {}),
    ...(preset.featured ? { featured: preset.featured } : {}),
    transport: ("transport" in preset && preset.transport === "stdio" ? "stdio" : "remote") as
      | "stdio"
      | "remote",
    ...("command" in preset ? { command: preset.command } : {}),
    ...("args" in preset && preset.args ? { args: [...preset.args] } : {}),
    ...("env" in preset && preset.env ? { env: preset.env } : {}),
  }));

  return {
    id: MCP_PLUGIN_ID,
    packageName: "@executor-js/plugin-mcp",
    integrationPresets: presetEntries,
    // Surfaced to the client bundle via the Vite plugin. The MCP `./client`
    // factory reads `allowStdio` and gates the stdio tab + presets.
    clientConfig: { allowStdio },
    storage: () => ({}),

    extension: (ctx: PluginCtx) => {
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
          const slug = deriveMcpNamespace({ endpoint: trimmed });

          const probeHeaders = typeof input === "string" ? undefined : input.headers;
          const probeQueryParams = typeof input === "string" ? undefined : input.queryParams;

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
              requiresAuthentication: false,
              requiresOAuth: false,
              supportsDynamicRegistration: false,
              name: result.manifest.server?.name ?? name,
              slug,
              toolCount: result.manifest.tools.length,
              serverName: result.manifest.server?.name ?? null,
            } satisfies McpProbeResult;
          }

          // Confirm the endpoint actually speaks MCP before classifying it as
          // OAuth-protected (an OAuth-protected non-MCP service would
          // otherwise be misclassified).
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

          const probeResult = yield* ctx.oauth.probe({ url: trimmed }).pipe(
            Effect.map((oauth) => ({ ok: true as const, oauth })),
            Effect.catch(() => Effect.succeed({ ok: false as const, oauth: null })),
            Effect.withSpan("mcp.plugin.probe_oauth"),
          );

          if (probeResult.ok) {
            return {
              connected: false,
              requiresAuthentication: true,
              requiresOAuth: true,
              supportsDynamicRegistration: probeResult.oauth.registrationEndpoint != null,
              name,
              slug,
              toolCount: null,
              serverName: null,
            } satisfies McpProbeResult;
          }

          if (shape.requiresAuth) {
            return {
              connected: false,
              requiresAuthentication: true,
              requiresOAuth: false,
              supportsDynamicRegistration: false,
              name,
              slug,
              toolCount: null,
              serverName: null,
            } satisfies McpProbeResult;
          }

          return yield* new McpConnectionError({
            transport: "remote",
            message:
              "This endpoint looks like MCP, but Executor couldn't discover tools from it. Check the URL and try again.",
          });
        }).pipe(
          Effect.withSpan("mcp.plugin.probe_endpoint", {
            attributes: { "mcp.endpoint": typeof input === "string" ? input : input.endpoint },
          }),
        );

      const addServer = (input: McpServerInput) =>
        Effect.gen(function* () {
          const slug = normalizeSlug(input);
          const config = toIntegrationConfig(input);

          // Block re-adding an existing slug. The core `integrations.register`
          // primitive upserts (so boot re-registration is idempotent), but an
          // explicit add must NOT silently clobber an existing integration's
          // tools, connections, and policies. To add more auth, update the
          // existing integration instead.
          const existing = yield* ctx.core.integrations.get(slugFrom(slug));
          if (existing) {
            return yield* new IntegrationAlreadyExistsError({ slug: slugFrom(slug) });
          }

          yield* ctx.core.integrations
            .register({
              slug: slugFrom(slug),
              description: input.name,
              config,
              canRemove: true,
              canRefresh: true,
            })
            .pipe(
              Effect.withSpan("mcp.plugin.register_integration", {
                attributes: { "mcp.integration.slug": slug },
              }),
            );
          return { slug };
        }).pipe(
          Effect.withSpan("mcp.plugin.add_server", {
            attributes: {
              "mcp.server.transport": input.transport ?? "remote",
              "mcp.server.name": input.name,
            },
          }),
        );

      const removeServer = (slug: string) =>
        Effect.gen(function* () {
          const integration = slugFrom(slug);
          const record = yield* ctx.core.integrations.get(integration);
          const config = record ? parseMcpIntegrationConfig(record.config) : null;
          const legacyCandidates = legacyOAuthClientSlugCandidates(slug, record);
          const connections = yield* ctx.connections.list({ integration });
          const allConnections = yield* ctx.connections.list();
          const oauthClientSummaries = yield* ctx.oauth.listClients();
          const usedElsewhere = new Set(
            allConnections
              .filter((connection) => String(connection.integration) !== String(integration))
              .flatMap((connection) =>
                connection.oauthClient == null
                  ? []
                  : [
                      oauthClientKey(
                        connection.oauthClientOwner ?? connection.owner,
                        connection.oauthClient,
                      ),
                    ],
              ),
          );
          const oauthClientsByKey = new Map(
            oauthClientSummaries.map((client) => [
              oauthClientKey(client.owner, client.slug),
              client,
            ]),
          );
          const clientsToRemove = new Map<
            string,
            { readonly owner: Owner; readonly slug: OAuthClientSlug }
          >();

          for (const connection of connections) {
            if (connection.oauthClient == null) continue;
            const owner = connection.oauthClientOwner ?? connection.owner;
            const key = oauthClientKey(owner, connection.oauthClient);
            const client = oauthClientsByKey.get(key);
            if (client?.origin.kind !== "dynamic_client_registration") continue;
            clientsToRemove.set(key, {
              owner,
              slug: connection.oauthClient,
            });
          }
          for (const client of oauthClientSummaries) {
            const key = oauthClientKey(client.owner, client.slug);
            if (usedElsewhere.has(key)) continue;
            if (
              client.origin.kind === "dynamic_client_registration" &&
              (client.origin.integration == null || String(client.origin.integration) === slug)
            ) {
              clientsToRemove.set(key, { owner: client.owner, slug: client.slug });
              continue;
            }
            if (legacyMcpClientMatches(client, legacyCandidates, config)) {
              clientsToRemove.set(key, { owner: client.owner, slug: client.slug });
            }
          }

          yield* ctx.core.integrations
            .remove(integration)
            .pipe(Effect.catchTag("IntegrationRemovalNotAllowedError", () => Effect.void));

          yield* Effect.forEach(
            clientsToRemove.values(),
            (client) => ctx.oauth.removeClient(client.owner, client.slug),
            { discard: true },
          );
        }).pipe(
          Effect.withSpan("mcp.plugin.remove_server", {
            attributes: { "mcp.integration.slug": slug },
          }),
        );

      const getServer = (slug: string) =>
        ctx.core.integrations.get(slugFrom(slug)).pipe(
          Effect.withSpan("mcp.plugin.get_server", {
            attributes: { "mcp.integration.slug": slug },
          }),
        );

      const configureServer = (slug: string, config: McpIntegrationConfigType) =>
        ctx.core.integrations.update(slugFrom(slug), { config }).pipe(
          Effect.withSpan("mcp.plugin.configure_server", {
            attributes: { "mcp.integration.slug": slug },
          }),
        );

      /** Merge-append auth methods onto the integration's existing
       *  `authenticationTemplate` (custom-method-create flow), mirroring the
       *  OpenAPI/GraphQL `configureAuth`. Returns the merged array. A no-op
       *  (returns `[]`) for an unknown slug, a stdio server, or an
       *  undecodable config. */
      const configureAuth = (slug: string, input: McpConfigureAuthInput) =>
        Effect.gen(function* () {
          const record = yield* ctx.core.integrations.get(slugFrom(slug));
          const current = record ? parseMcpIntegrationConfig(record.config) : null;
          if (!current || current.transport === "stdio") {
            return [] as readonly McpAuthMethod[];
          }

          // Replace mode declares the full set — backfill kind-based slugs.
          // Merge mode appends: `mergeAuthTemplates` replaces on slug match and
          // assigns fresh `custom_<id>` slugs to slug-less entries, so a custom
          // method never silently displaces a declared one.
          const merged =
            input.mode === "replace"
              ? normalizeMcpAuthMethods(input.authenticationTemplate)
              : mergeAuthTemplates(
                  current.authenticationTemplate,
                  expandMcpAuthMethodInputs(
                    input.authenticationTemplate,
                  ) as readonly McpAuthMethod[],
                );

          yield* ctx.core.integrations.update(slugFrom(slug), {
            config: { ...current, authenticationTemplate: merged },
          });

          return merged;
        }).pipe(
          Effect.withSpan("mcp.plugin.configure_auth", {
            attributes: { "mcp.integration.slug": slug },
          }),
        );

      return {
        probeEndpoint,
        addServer,
        removeServer,
        getServer,
        configureServer,
        configureAuth,
      };
    },

    // -----------------------------------------------------------------------
    // Per-connection tool production. Dial the server using the connection's
    // resolved value (rendered through the integration's auth template) and
    // list its tools. The real MCP tool name + upstream annotations are
    // stamped into each ToolDef's annotations so invokeTool can recover them.
    // Discovery failures (auth not ready, server down) yield an empty tool set
    // rather than failing — the connection still lands and can be refreshed.
    // -----------------------------------------------------------------------
    resolveTools: ({ config, connection, template, getValues }) =>
      Effect.gen(function* () {
        const parsed = parseMcpIntegrationConfig(config);
        if (!parsed) return { tools: [] as readonly ToolDef[] };

        // Discovery tolerates unresolved credentials (an open server lists
        // tools unauthenticated; a bad value just yields zero tools).
        const values = yield* getValues().pipe(
          Effect.orElseSucceed(() => ({}) as Record<string, string | null>),
        );

        const built = yield* buildConnectorInput(
          parsed,
          values,
          template === null ? null : String(template),
          allowStdio,
        ).pipe(
          Effect.map((ci) => createMcpConnector(ci)),
          Effect.result,
        );

        const manifest = Result.isSuccess(built)
          ? yield* discoverTools(built.success).pipe(
              Effect.map((m) => ({ ok: true as const, manifest: m })),
              Effect.catch(() => Effect.succeed({ ok: false as const, manifest: null })),
              Effect.withSpan("mcp.plugin.discover_tools", {
                attributes: { "mcp.connection.name": String(connection.name) },
              }),
            )
          : { ok: false as const, manifest: null };

        const entries = manifest.ok && manifest.manifest ? manifest.manifest.tools : [];
        return { tools: entries.map(toToolDef) };
      }).pipe(
        Effect.withSpan("mcp.plugin.resolve_tools", {
          attributes: { "mcp.connection.name": String(connection.name) },
        }),
      ) as Effect.Effect<{ readonly tools: readonly ToolDef[] }, StorageFailure>,

    invokeTool: ({ toolRow, credential, args, elicit }) =>
      Effect.gen(function* () {
        const parsed = parseMcpIntegrationConfig(credential.config);
        if (!parsed) {
          return yield* new McpConnectionError({
            transport: "auto",
            message: `MCP integration "${toolRow.integration}" has no usable config`,
          });
        }

        const stamp = readStamp(toolRow.annotations);
        if (!stamp) {
          return yield* new McpToolDiscoveryError({
            stage: "list_tools",
            message: `Tool "${toolRow.name}" is missing its MCP binding — refresh the connection`,
          });
        }

        const transport: string =
          parsed.transport === "stdio" ? "stdio" : (parsed.remoteTransport ?? "auto");

        // An apikey method with unresolved inputs fails the invocation
        // explicitly instead of dialing unauthenticated.
        if (parsed.transport === "remote") {
          const method = selectAuthMethod(parsed, String(credential.template));
          if (method?.kind === "apikey") {
            const missing = requiredPlacementVariables(method.placements).filter(
              (variable) => credential.values[variable] == null,
            );
            if (missing.length > 0) {
              return authToolFailure({
                code: "connection_value_missing",
                message: `Connection has no resolvable credential value for input(s): ${missing.join(", ")}. Re-create the connection with the required value(s).`,
                source: { id: String(credential.integration) },
                credential: { kind: "upstream", label: String(credential.connection) },
              });
            }
          }
        }

        const connector: McpConnector = yield* buildConnectorInput(
          parsed,
          credential.values,
          String(credential.template),
          allowStdio,
        ).pipe(Effect.map((ci) => createMcpConnector(ci)));

        const raw = yield* invokeMcpTool({
          toolId: String(toolRow.name),
          toolName: stamp.toolName,
          args,
          transport,
          connector,
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
        Effect.catchTag("McpConnectionError", ({ message }) =>
          Effect.succeed(
            authToolFailure({
              code: "connection_rejected",
              message,
              source: { id: String(credential.integration) },
              credential: { kind: "upstream", label: String(credential.connection) },
            }),
          ),
        ),
        Effect.withSpan("mcp.plugin.invoke_tool", {
          attributes: {
            "mcp.tool.name": String(toolRow.name),
            "mcp.integration.slug": String(toolRow.integration),
          },
        }),
      ),

    detect: ({ ctx, url }: { readonly ctx: PluginCtx; readonly url: string }) =>
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
        const slug = deriveMcpNamespace({ endpoint: trimmed });

        const connector = createMcpConnector({ transport: "remote", endpoint: trimmed });

        const connected = yield* discoverTools(connector).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
          Effect.withSpan("mcp.plugin.discover_tools"),
        );

        if (connected) {
          return {
            kind: MCP_PLUGIN_ID,
            confidence: "high" as const,
            endpoint: trimmed,
            name,
            slug,
          };
        }

        const shape = yield* probeMcpEndpointShape(trimmed, { httpClientLayer });
        if (shape.kind === "mcp") {
          return {
            kind: MCP_PLUGIN_ID,
            confidence: "high" as const,
            endpoint: trimmed,
            name,
            slug,
          };
        }

        // Low-confidence URL-token fallback when wire-shape detection can't
        // confirm MCP but the URL itself is a strong hint.
        if (urlMatchesToken(parsed.value, "mcp")) {
          return {
            kind: MCP_PLUGIN_ID,
            confidence: "low" as const,
            endpoint: trimmed,
            name,
            slug,
          };
        }

        return null;
      }).pipe(
        Effect.catch(() => Effect.succeed(null)),
        Effect.withSpan("mcp.plugin.detect", {
          attributes: { "mcp.endpoint": url },
        }),
      ),

    // Honour upstream destructiveHint from MCP ToolAnnotations using the stamp
    // persisted in each tool row's annotations.
    resolveAnnotations: ({ toolRows }) =>
      Effect.sync(() => {
        const out: Record<string, ToolAnnotations> = {};
        for (const row of toolRows) {
          const stamp = readStamp(row.annotations);
          const ann = stamp?.upstream;
          if (ann?.destructiveHint === true) {
            out[String(row.name)] = {
              requiresApproval: true,
              approvalDescription: ann.title ?? stamp?.toolName ?? String(row.name),
            };
          } else {
            out[String(row.name)] = { requiresApproval: false };
          }
        }
        return out;
      }),

    describeAuthMethods: describeMcpAuthMethods,
    describeIntegrationDisplay: describeMcpIntegrationDisplay,

    integrationConfigure: {
      type: "mcp",
      configure: ({ ctx, integration, config }) =>
        Effect.gen(function* () {
          const next = parseMcpIntegrationConfig(config);
          if (!next) return;
          yield* ctx.core.integrations.update(integration, { config: next });
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
              "Probe a remote MCP endpoint before adding it. If the result requires OAuth, run the core OAuth handoff (`oauth.probe`, `oauth.start`) to mint a connection; otherwise create a connection with `connections.create` carrying the API key or header value.",
            inputSchema: McpProbeEndpointInputStandardSchema,
            outputSchema: McpProbeEndpointOutputStandardSchema,
            execute: (input) =>
              self.probeEndpoint(input as McpProbeEndpointInput).pipe(
                Effect.map(ToolResult.ok),
                Effect.catchTag("McpConnectionError", ({ message, transport }) =>
                  Effect.succeed(mcpToolFailure("mcp_connection_failed", message, { transport })),
                ),
              ),
          }),
          tool({
            name: "getServer",
            description:
              "Inspect a registered MCP integration, including transport, endpoint/command, and auth template. Use this before creating a connection (`connections.create` / `oauth.start`).",
            inputSchema: McpGetServerInputStandardSchema,
            outputSchema: McpGetServerOutputStandardSchema,
            execute: (input) => {
              const args = input as typeof McpGetServerInputSchema.Type;
              return Effect.map(self.getServer(args.slug), (integration) =>
                ToolResult.ok({ integration }),
              );
            },
          }),
          tool({
            name: "addServer",
            description:
              "Register an MCP server in the catalog as an integration. Returns its `slug`. Then create a connection against it: for header/API-key auth call `connections.create` with the value; for OAuth-protected servers run `oauth.probe` + `oauth.start`. Tools are produced per-connection at connection create / refresh.",
            annotations: {
              requiresApproval: true,
              approvalDescription: "Add an MCP server",
            },
            inputSchema: McpAddServerInputStandardSchema,
            outputSchema: McpAddServerOutputStandardSchema,
            execute: (rawInput) => {
              const input = rawInput as typeof McpAddServerInputSchema.Type;
              return self.addServer(input as McpServerInput).pipe(
                Effect.map(ToolResult.ok),
                Effect.catchTag(
                  "IntegrationAlreadyExistsError",
                  ({ slug }: IntegrationAlreadyExistsError) =>
                    Effect.succeed(
                      mcpToolFailure(
                        "integration_already_exists",
                        `Integration ${slug} already exists; update it instead of re-adding.`,
                      ),
                    ),
                ),
              );
            },
          }),
        ],
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// McpPluginExtension — shape of `executor.mcp` for consumers (api/, react/).
// ---------------------------------------------------------------------------

export type McpExtensionFailure = McpConnectionError | McpToolDiscoveryError | StorageFailure;

export interface McpPluginExtension {
  readonly probeEndpoint: (
    input: string | McpProbeEndpointInput,
  ) => Effect.Effect<McpProbeResult, McpExtensionFailure>;
  readonly addServer: (
    input: McpServerInput,
  ) => Effect.Effect<
    { readonly slug: string },
    McpExtensionFailure | IntegrationAlreadyExistsError
  >;
  readonly removeServer: (slug: string) => Effect.Effect<void, McpExtensionFailure>;
  readonly getServer: (
    slug: string,
  ) => Effect.Effect<
    (Integration & { readonly config: IntegrationConfig }) | null,
    McpExtensionFailure
  >;
  readonly configureServer: (
    slug: string,
    config: McpIntegrationConfigType,
  ) => Effect.Effect<void, McpExtensionFailure>;
  readonly configureAuth: (
    slug: string,
    input: McpConfigureAuthInput,
  ) => Effect.Effect<readonly McpAuthMethod[], McpExtensionFailure>;
}
