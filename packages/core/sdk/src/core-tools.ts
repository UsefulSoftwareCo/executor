// ---------------------------------------------------------------------------
// core-tools plugin
//
// Built-in plugin that contributes agent-facing static tools for configuring
// executor-level primitives over the v2 surface. Agent-facing connection setup
// should hand users to the web UI for pasted credentials; low-level creation
// through this plugin only accepts provider refs.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import type { Connection, ConnectionInputOrigin, CreateConnectionInput } from "./connection";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  NO_AUTH_TEMPLATE,
  OAuthClientSlug,
  OAuthState,
  ProviderItemId,
  ProviderKey,
  type Owner,
} from "./ids";
import { definePlugin, tool, type StaticToolSchema } from "./plugin";
import { ToolPolicyActionSchema } from "./policies";
import type { Tool } from "./tool";

const schemaToStandard = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const OwnerSchema = Schema.Literals(["org", "user"]);
const OAuthGrantSchema = Schema.Literals(["authorization_code", "client_credentials"]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IntegrationOutput = Schema.Struct({
  slug: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
});

const IntegrationsListOutput = Schema.Struct({
  integrations: Schema.Array(IntegrationOutput),
});

const DetectInput = Schema.Struct({ url: Schema.String });
const DetectOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      confidence: Schema.Literals(["high", "medium", "low"]),
      endpoint: Schema.String,
      name: Schema.String,
      slug: Schema.String,
    }),
  ),
});

const ConnectionOutput = Schema.Struct({
  owner: OwnerSchema,
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  provider: Schema.String,
  address: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  expiresAt: Schema.NullOr(Schema.Number),
  oauthClient: Schema.NullOr(Schema.String),
  oauthClientOwner: Schema.NullOr(OwnerSchema),
  oauthScope: Schema.NullOr(Schema.String),
});

const ConnectionsListInput = Schema.Struct({
  integration: Schema.optional(Schema.String),
  owner: Schema.optional(OwnerSchema),
  verbose: Schema.optional(Schema.Boolean),
});

/** Lean per-connection shape for list scans. Omits the full `oauthScope`
 *  grant string (a single connection's scope list can run to thousands of
 *  characters and dominates the payload) in favor of `oauthScopeCount`. The
 *  full scope is included only when the caller passes `verbose: true`. */
const ConnectionListItem = Schema.Struct({
  owner: OwnerSchema,
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  provider: Schema.String,
  address: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  expiresAt: Schema.NullOr(Schema.Number),
  oauthClient: Schema.NullOr(Schema.String),
  oauthClientOwner: Schema.NullOr(OwnerSchema),
  oauthScopeCount: Schema.NullOr(Schema.Number),
  oauthScope: Schema.optional(Schema.NullOr(Schema.String)),
});
const ConnectionsListOutput = Schema.Struct({
  connections: Schema.Array(ConnectionListItem),
});

const ConnectionCreateHandoffInput = Schema.Struct({
  integration: Schema.String,
  owner: Schema.optional(OwnerSchema),
  template: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
});
const ConnectionCreateHandoffOutput = Schema.Struct({
  url: Schema.String,
  instructions: Schema.String,
});

const ConnectionFromInput = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
});
const ConnectionInputOriginInput = Schema.Struct({ from: ConnectionFromInput });
const ConnectionCreateInput = Schema.Struct({
  owner: OwnerSchema,
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  from: Schema.optional(ConnectionFromInput),
  inputs: Schema.optional(Schema.Record(Schema.String, ConnectionInputOriginInput)),
}).check(
  Schema.makeFilter((payload) => {
    const originCount =
      (payload.from === undefined ? 0 : 1) + (payload.inputs === undefined ? 0 : 1);
    // The no-auth template ("none") binds zero credentials — both `from` and
    // `inputs` are legitimately absent (public MCP servers, public REST APIs).
    // Mirror the engine, which accepts an empty input set only for this
    // template; a stray origin would wire a credential the connection can't
    // hold, so reject any. Every other template needs exactly one origin.
    const isNoAuth = String(payload.template) === String(NO_AUTH_TEMPLATE);
    if (isNoAuth) {
      if (originCount > 0) {
        return 'A no-auth connection (template "none") takes no provider credential origin';
      }
    } else if (originCount !== 1) {
      return "Expected exactly one provider credential origin";
    }
    if (payload.inputs !== undefined && Object.keys(payload.inputs).length === 0) {
      return "Expected at least one provider credential input";
    }
    return undefined;
  }),
);
const ConnectionRefInput = Schema.Struct({
  owner: OwnerSchema,
  name: Schema.String,
  integration: Schema.String,
});

const ToolOutput = Schema.Struct({
  address: Schema.String,
  owner: OwnerSchema,
  integration: Schema.String,
  connection: Schema.String,
  name: Schema.String,
  pluginId: Schema.String,
  description: Schema.String,
});
const ConnectionsRefreshOutput = Schema.Struct({
  tools: Schema.Array(ToolOutput),
});

const RemovedOutput = Schema.Struct({ removed: Schema.Boolean });
const CancelledOutput = Schema.Struct({ cancelled: Schema.Boolean });

const ProvidersOutput = Schema.Struct({
  providers: Schema.Array(Schema.String),
});

const ProviderItemsInput = Schema.Struct({ provider: Schema.String });
const ProviderItemsOutput = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const PolicyOutput = Schema.Struct({
  id: Schema.String,
  owner: OwnerSchema,
  pattern: Schema.String,
  action: Schema.String,
  position: Schema.String,
});
const PoliciesListOutput = Schema.Struct({
  policies: Schema.Array(PolicyOutput),
});

const PolicyCreateInput = Schema.Struct({
  owner: OwnerSchema,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
});
const PolicyUpdateInput = Schema.Struct({
  id: Schema.String,
  owner: OwnerSchema,
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
});
const PolicyRemoveInput = Schema.Struct({
  id: Schema.String,
  owner: OwnerSchema,
});

const OAuthClientOutput = Schema.Struct({
  owner: OwnerSchema,
  slug: Schema.String,
  grant: OAuthGrantSchema,
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  clientId: Schema.String,
  origin: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("manual") }),
    Schema.Struct({
      kind: Schema.Literal("dynamic_client_registration"),
      integration: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ]),
});
const OAuthClientsListOutput = Schema.Struct({
  clients: Schema.Array(OAuthClientOutput),
});
// No `clientSecret`: a confidential client's secret must never cross the agent
// boundary (it would land in the LLM context window). This tool registers a
// PUBLIC client only; a secret-bearing app is registered by the human through
// `oauth.clients.createHandoff`, which deep-links them to the web form.
const OAuthCreateClientInput = Schema.Struct({
  owner: OwnerSchema,
  slug: Schema.String,
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  grant: OAuthGrantSchema,
  clientId: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
});
// Browser-handoff for a CONFIDENTIAL OAuth app: carries only the NON-secret
// fields the form pre-fills. The client secret is typed by the human in the web
// UI, exactly like a pasted connection credential, so it never reaches the
// agent. Mirrors `ConnectionCreateHandoffInput`.
const OAuthCreateClientHandoffInput = Schema.Struct({
  integration: Schema.String,
  owner: Schema.optional(OwnerSchema),
  slug: Schema.optional(Schema.String),
  grant: Schema.optional(OAuthGrantSchema),
  clientId: Schema.optional(Schema.String),
  authorizationUrl: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.String),
});
const OAuthCreateClientHandoffOutput = Schema.Struct({
  url: Schema.String,
  instructions: Schema.String,
});
const OAuthClientOutputRef = Schema.Struct({
  client: Schema.String,
});
const OAuthRegisterDynamicInput = Schema.Struct({
  owner: OwnerSchema,
  slug: Schema.String,
  registrationEndpoint: Schema.String,
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: Schema.Array(Schema.String),
  tokenEndpointAuthMethodsSupported: Schema.optional(Schema.Array(Schema.String)),
  clientName: Schema.optional(Schema.String),
  redirectUri: Schema.optional(Schema.NullOr(Schema.String)),
  originIntegration: Schema.optional(Schema.NullOr(Schema.String)),
});
const OAuthRemoveClientInput = Schema.Struct({
  owner: OwnerSchema,
  slug: Schema.String,
});
const OAuthProbeInput = Schema.Struct({
  url: Schema.String,
});
const OAuthProbeOutput = Schema.Struct({
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopesSupported: Schema.optional(Schema.Array(Schema.String)),
  registrationEndpoint: Schema.optional(Schema.NullOr(Schema.String)),
  tokenEndpointAuthMethodsSupported: Schema.optional(Schema.Array(Schema.String)),
  clientIdMetadataDocumentSupported: Schema.optional(Schema.Boolean),
});
const OAuthStartInput = Schema.Struct({
  client: Schema.String,
  clientOwner: OwnerSchema,
  owner: OwnerSchema,
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  redirectUri: Schema.optional(Schema.NullOr(Schema.String)),
});
const OAuthStartOutput = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("connected"),
    connection: ConnectionOutput,
  }),
  Schema.Struct({
    status: Schema.Literal("redirect"),
    authorizationUrl: Schema.String,
    state: Schema.String,
  }),
]);
const OAuthCancelInput = Schema.Struct({
  state: Schema.String,
});

// Standard-schema versions for the tool() builder.
const IntegrationsListOutputStd = schemaToStandard(IntegrationsListOutput);
const DetectInputStd = schemaToStandard(DetectInput);
const DetectOutputStd = schemaToStandard(DetectOutput);
const ConnectionsListInputStd = schemaToStandard(ConnectionsListInput);
const ConnectionsListOutputStd = schemaToStandard(ConnectionsListOutput);
const ConnectionCreateHandoffInputStd = schemaToStandard(ConnectionCreateHandoffInput);
const ConnectionCreateHandoffOutputStd = schemaToStandard(ConnectionCreateHandoffOutput);
const ConnectionCreateInputStd = schemaToStandard(ConnectionCreateInput);
const ConnectionOutputStd = schemaToStandard(ConnectionOutput);
const ConnectionRefInputStd = schemaToStandard(ConnectionRefInput);
const ConnectionsRefreshOutputStd = schemaToStandard(ConnectionsRefreshOutput);
const RemovedOutputStd = schemaToStandard(RemovedOutput);
const CancelledOutputStd = schemaToStandard(CancelledOutput);
const ProvidersOutputStd = schemaToStandard(ProvidersOutput);
const ProviderItemsInputStd = schemaToStandard(ProviderItemsInput);
const ProviderItemsOutputStd = schemaToStandard(ProviderItemsOutput);
const PoliciesListOutputStd = schemaToStandard(PoliciesListOutput);
const PolicyOutputStd = schemaToStandard(PolicyOutput);
const PolicyCreateInputStd = schemaToStandard(PolicyCreateInput);
const PolicyUpdateInputStd = schemaToStandard(PolicyUpdateInput);
const PolicyRemoveInputStd = schemaToStandard(PolicyRemoveInput);
const OAuthClientsListOutputStd = schemaToStandard(OAuthClientsListOutput);
const OAuthCreateClientInputStd = schemaToStandard(OAuthCreateClientInput);
const OAuthCreateClientHandoffInputStd = schemaToStandard(OAuthCreateClientHandoffInput);
const OAuthCreateClientHandoffOutputStd = schemaToStandard(OAuthCreateClientHandoffOutput);
const OAuthClientOutputRefStd = schemaToStandard(OAuthClientOutputRef);
const OAuthRegisterDynamicInputStd = schemaToStandard(OAuthRegisterDynamicInput);
const OAuthRemoveClientInputStd = schemaToStandard(OAuthRemoveClientInput);
const OAuthProbeInputStd = schemaToStandard(OAuthProbeInput);
const OAuthProbeOutputStd = schemaToStandard(OAuthProbeOutput);
const OAuthStartInputStd = schemaToStandard(OAuthStartInput);
const OAuthStartOutputStd = schemaToStandard(OAuthStartOutput);
const OAuthCancelInputStd = schemaToStandard(OAuthCancelInput);

const connectionToOutput = (connection: Connection) => ({
  owner: connection.owner,
  name: String(connection.name),
  integration: String(connection.integration),
  template: String(connection.template),
  provider: String(connection.provider),
  address: String(connection.address),
  identityLabel: connection.identityLabel ?? null,
  description: connection.description ?? null,
  expiresAt: connection.expiresAt ?? null,
  oauthClient: connection.oauthClient == null ? null : String(connection.oauthClient),
  oauthClientOwner: connection.oauthClientOwner ?? null,
  oauthScope: connection.oauthScope ?? null,
});

/** Number of space-separated grants in an `oauthScope` string, or null when
 *  the connection carries no scope (static credentials, or an OAuth AS that
 *  omitted scope). */
const oauthScopeCount = (scope: string | null | undefined): number | null =>
  scope == null ? null : scope.split(/\s+/).filter(Boolean).length;

/** Lean projection for `connections.list`. Summarizes `oauthScope` to a count
 *  unless `verbose`, where the full grant string is included too. */
const connectionToListItem = (connection: Connection, verbose: boolean) => ({
  owner: connection.owner,
  name: String(connection.name),
  integration: String(connection.integration),
  template: String(connection.template),
  provider: String(connection.provider),
  address: String(connection.address),
  identityLabel: connection.identityLabel ?? null,
  description: connection.description ?? null,
  expiresAt: connection.expiresAt ?? null,
  oauthClient: connection.oauthClient == null ? null : String(connection.oauthClient),
  oauthClientOwner: connection.oauthClientOwner ?? null,
  oauthScopeCount: oauthScopeCount(connection.oauthScope),
  ...(verbose ? { oauthScope: connection.oauthScope ?? null } : {}),
});

const toolToOutput = (toolRow: Tool) => ({
  address: String(toolRow.address),
  owner: toolRow.owner,
  integration: String(toolRow.integration),
  connection: String(toolRow.connection),
  name: String(toolRow.name),
  pluginId: toolRow.pluginId,
  description: toolRow.description,
});

const connectionRefFromInput = (input: typeof ConnectionRefInput.Type) => ({
  owner: input.owner as Owner,
  integration: IntegrationSlug.make(input.integration),
  name: ConnectionName.make(input.name),
});

const originFromInput = (
  origin: typeof ConnectionInputOriginInput.Type,
): ConnectionInputOrigin => ({
  from: {
    provider: ProviderKey.make(origin.from.provider),
    id: ProviderItemId.make(origin.from.id),
  },
});

const createConnectionInputFromTool = (
  input: typeof ConnectionCreateInput.Type,
): CreateConnectionInput => {
  const base = {
    owner: input.owner as Owner,
    name: ConnectionName.make(input.name),
    integration: IntegrationSlug.make(input.integration),
    template: AuthTemplateSlug.make(input.template),
    identityLabel: input.identityLabel ?? null,
  };

  if (input.from !== undefined) {
    return {
      ...base,
      from: {
        provider: ProviderKey.make(input.from.provider),
        id: ProviderItemId.make(input.from.id),
      },
    };
  }
  return {
    ...base,
    inputs: Object.fromEntries(
      Object.entries(input.inputs ?? {}).map(([variable, origin]) => [
        variable,
        originFromInput(origin),
      ]),
    ),
  };
};

const connectionCreateHandoffUrl = (
  webBaseUrl: string | undefined,
  orgSlug: string | undefined,
  input: typeof ConnectionCreateHandoffInput.Type,
): string => {
  const search = new URLSearchParams({ addAccount: "1" });
  if (input.owner !== undefined) search.set("owner", input.owner);
  if (input.template !== undefined) search.set("template", input.template);
  if (input.label !== undefined) search.set("label", input.label);
  // Org-scoped hosts (cloud, self-host, cloudflare) serve the console under an
  // optional `/<org-slug>` segment. Pin the URL to the executor's bound org so
  // it opens that org directly instead of relying on the browser's last-active
  // org (which `OrgSlugGate` would otherwise canonicalize a bare URL to). When
  // no slug is known (CLI, local, non-request callers) we emit the bare path.
  const orgPrefix = orgSlug !== undefined && orgSlug.length > 0 ? `/${orgSlug}` : "";
  const path = `${orgPrefix}/integrations/${encodeURIComponent(input.integration)}?${search.toString()}`;
  if (webBaseUrl === undefined || webBaseUrl.length === 0) return path;
  return new URL(path, webBaseUrl.endsWith("/") ? webBaseUrl : `${webBaseUrl}/`).toString();
};

const oauthClientCreateHandoffUrl = (
  webBaseUrl: string | undefined,
  orgSlug: string | undefined,
  input: typeof OAuthCreateClientHandoffInput.Type,
): string => {
  // `oauthClient=1` flips the integration's Add-account flow straight into the
  // Register-OAuth-app form; the rest pre-fill its NON-secret fields. The client
  // secret is deliberately absent: the human types it in the browser, so it is
  // never placed in this URL (nor in the agent's context). Same builder shape as
  // `connectionCreateHandoffUrl`.
  const search = new URLSearchParams({ addAccount: "1", oauthClient: "1" });
  if (input.owner !== undefined) search.set("owner", input.owner);
  if (input.slug !== undefined) search.set("clientSlug", input.slug);
  if (input.grant !== undefined) search.set("grant", input.grant);
  if (input.clientId !== undefined) search.set("clientId", input.clientId);
  if (input.authorizationUrl !== undefined) search.set("authorizationUrl", input.authorizationUrl);
  if (input.tokenUrl !== undefined) search.set("tokenUrl", input.tokenUrl);
  if (input.resource != null && input.resource.length > 0) search.set("resource", input.resource);
  if (input.label !== undefined) search.set("label", input.label);
  const orgPrefix = orgSlug !== undefined && orgSlug.length > 0 ? `/${orgSlug}` : "";
  const path = `${orgPrefix}/integrations/${encodeURIComponent(input.integration)}?${search.toString()}`;
  if (webBaseUrl === undefined || webBaseUrl.length === 0) return path;
  return new URL(path, webBaseUrl.endsWith("/") ? webBaseUrl : `${webBaseUrl}/`).toString();
};

export interface CoreToolsPluginOptions {
  readonly webBaseUrl?: string;
  /** The bound org's URL slug, prefixed onto browser-handoff URLs so they open
   *  the right org's console (`${webBaseUrl}/<orgSlug>/integrations/...`). */
  readonly orgSlug?: string;
  readonly includeProviders?: boolean;
}

export const coreToolsPlugin = definePlugin((options: CoreToolsPluginOptions = {}) => ({
  id: "core-tools" as const,
  packageName: "@executor-js/sdk/core-tools",
  storage: () => ({}),
  extension: () => ({}),

  staticSources: () => [
    {
      id: "coreTools",
      kind: "executor",
      name: "Executor",
      tools: [
        tool({
          name: "integrations.list",
          description:
            "List integrations in the workspace catalog (slug, description, owning plugin kind). Connections authenticate against these.",
          outputSchema: IntegrationsListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.core.integrations.list(), (integrations) => ({
              integrations: integrations.map((i) => ({
                slug: String(i.slug),
                description: i.description,
                kind: i.kind,
                canRemove: i.canRemove,
                canRefresh: i.canRefresh,
              })),
            })),
        }),
        tool({
          name: "integrations.detect",
          description:
            "Given a URL, ask every plugin whether it recognizes it, returning best-confidence matches so the UI can pre-fill onboarding for the right plugin.",
          inputSchema: DetectInputStd,
          outputSchema: DetectOutputStd,
          execute: (input: typeof DetectInput.Type, { ctx }) =>
            Effect.map(ctx.core.integrations.detect(input.url), (results) => ({
              results: results.map((r) => ({
                kind: r.kind,
                confidence: r.confidence,
                endpoint: r.endpoint,
                name: r.name,
                slug: r.slug,
              })),
            })),
        }),
        tool({
          name: "connections.list",
          description:
            "List saved connections (the credential for one integration). Never returns the credential value. Optionally filter by integration or owner. OAuth scopes are summarized as `oauthScopeCount` by default; pass `verbose: true` to include the full `oauthScope` grant string per connection.",
          inputSchema: ConnectionsListInputStd,
          outputSchema: ConnectionsListOutputStd,
          execute: (input: typeof ConnectionsListInput.Type, { ctx }) =>
            Effect.map(
              ctx.connections.list({
                integration:
                  input.integration === undefined
                    ? undefined
                    : IntegrationSlug.make(input.integration),
                owner: input.owner === undefined ? undefined : (input.owner as Owner),
              }),
              (connections) => ({
                connections: connections.map((connection) =>
                  connectionToListItem(connection, input.verbose === true),
                ),
              }),
            ),
        }),
        tool({
          name: "connections.create",
          description:
            'Low-level create or replace for a saved connection from provider item references. For a no-auth integration (public MCP server, public REST API), pass `template: "none"` with no `from`/`inputs` to wire it up directly. For normal API keys/tokens, use `connections.createHandoff` so the user enters the credential in the web UI. OAuth credentials should use `oauth.start`.',
          inputSchema: ConnectionCreateInputStd,
          outputSchema: ConnectionOutputStd,
          // Creating a connection binds a credential reference and roots a new
          // tool catalog: every tool that connection produces then becomes
          // callable. Even the no-auth (`template: "none"`) path pulls tools
          // from an arbitrary endpoint. Prompt-injected code could silently
          // wire an attacker-chosen integration or credential, so this is
          // approval-gated (the v1 `sources.configure` carried the same guard).
          annotations: { requiresApproval: true },
          execute: (input: typeof ConnectionCreateInput.Type, { ctx }) =>
            Effect.map(
              ctx.connections.create(createConnectionInputFromTool(input)),
              connectionToOutput,
            ),
        }),
        tool({
          name: "connections.createHandoff",
          description:
            "Return a browser URL that opens the Add account flow for one integration. Use this for API keys/tokens so the user enters secrets directly in the web UI instead of sending them through the agent. Optionally preselect owner, auth template, and a non-secret label.",
          inputSchema: ConnectionCreateHandoffInputStd,
          outputSchema: ConnectionCreateHandoffOutputStd,
          execute: (input: typeof ConnectionCreateHandoffInput.Type) => {
            const url = connectionCreateHandoffUrl(options.webBaseUrl, options.orgSlug, input);
            return Effect.succeed({
              url,
              instructions:
                "Ask the user to open this URL and add the account in the Executor web UI. Do not ask them to paste the credential value into chat. After they finish, call connections.list for the integration to discover the created connection.",
            });
          },
        }),
        tool({
          name: "connections.remove",
          description:
            "Remove a saved connection and its produced tools by owner, integration, and connection name.",
          inputSchema: ConnectionRefInputStd,
          outputSchema: RemovedOutputStd,
          // Deleting a connection drops it and every tool it produced, which
          // prompt-injected code could use to disrupt an integration or force a
          // re-add flow. Approval-gated, matching v1 `sources.remove`.
          annotations: { requiresApproval: true },
          execute: (input: typeof ConnectionRefInput.Type, { ctx }) =>
            Effect.map(ctx.connections.remove(connectionRefFromInput(input)), () => ({
              removed: true,
            })),
        }),
        tool({
          name: "connections.refresh",
          description:
            "Re-run an integration's tool production for a saved connection, replacing that connection's persisted tools.",
          inputSchema: ConnectionRefInputStd,
          outputSchema: ConnectionsRefreshOutputStd,
          // Refresh replaces a connection's persisted tool set; for a mutable
          // upstream (an MCP server whose catalog can change) this can swap in
          // different tools without confirmation. Approval-gated, matching v1
          // `sources.refresh`.
          annotations: { requiresApproval: true },
          execute: (input: typeof ConnectionRefInput.Type, { ctx }) =>
            Effect.map(ctx.connections.refresh(connectionRefFromInput(input)), (tools) => ({
              tools: tools.map(toolToOutput),
            })),
        }),
        // removed: tools.list — the cross-connection tool catalog is an
        // executor-surface read, not exposed on PluginCtx.
        ...(options.includeProviders === false
          ? []
          : [
              tool({
                name: "providers.list",
                description:
                  "List registered credential provider keys (the storage backends, not API vendors). Use `providers.items` to browse a backend's entries.",
                outputSchema: ProvidersOutputStd,
                execute: (_args, { ctx }) =>
                  Effect.map(ctx.providers.list(), (providers) => ({
                    providers: providers.map((p) => String(p)),
                  })),
              }),
              tool({
                name: "providers.items",
                description:
                  "Browse a credential provider's items for discovery (pick a 1Password / keychain entry). Returns opaque ids and labels, never values.",
                inputSchema: ProviderItemsInputStd,
                outputSchema: ProviderItemsOutputStd,
                execute: (input: typeof ProviderItemsInput.Type, { ctx }) =>
                  Effect.map(ctx.providers.items(ProviderKey.make(input.provider)), (items) => ({
                    items: items.map((i) => ({ id: String(i.id), name: i.name })),
                  })),
              }),
            ]),
        tool({
          name: "oauth.clients.list",
          description:
            "List registered OAuth clients visible to this executor. Returns metadata only; client secrets are never returned.",
          outputSchema: OAuthClientsListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.oauth.listClients(), (clients) => ({
              clients: clients.map((client) => ({
                owner: client.owner,
                slug: String(client.slug),
                grant: client.grant,
                authorizationUrl: client.authorizationUrl,
                tokenUrl: client.tokenUrl,
                resource: client.resource ?? null,
                clientId: client.clientId,
              })),
            })),
        }),
        tool({
          name: "oauth.clients.create",
          description:
            "Register or replace an owner-scoped OAuth client WITHOUT a client secret: a PUBLIC client (PKCE / authorization_code) or a discovery-prefill placeholder. To register a CONFIDENTIAL client that has a secret, call `oauth.clients.createHandoff` instead so the human enters the secret in the web UI; never pass a client secret through this tool.",
          inputSchema: OAuthCreateClientInputStd,
          outputSchema: OAuthClientOutputRefStd,
          // This persists an OAuth client and REPLACES on slug collision. It
          // takes NO client secret: a secret would have to travel through the
          // agent's context window, so a confidential app is registered by the
          // human via `oauth.clients.createHandoff`. An empty secret registers a
          // PUBLIC client. The remaining risk is the write itself: prompt-injected
          // code could register a client with an attacker-controlled
          // authorizationUrl/tokenUrl, then drive `oauth.start` to mint a
          // connection and route the user's tokens to the attacker. The
          // highest-value gate here; matches v1 `sources.bindings.set`, which
          // guarded credential writes.
          annotations: { requiresApproval: true },
          execute: (input: typeof OAuthCreateClientInput.Type, { ctx }) =>
            Effect.map(
              ctx.oauth.createClient({
                owner: input.owner as Owner,
                slug: OAuthClientSlug.make(input.slug),
                authorizationUrl: input.authorizationUrl,
                tokenUrl: input.tokenUrl,
                grant: input.grant,
                clientId: input.clientId,
                // No secret crosses the agent boundary; an empty secret registers
                // a public client. Confidential clients go through
                // `oauth.clients.createHandoff`.
                clientSecret: "",
                resource: input.resource ?? null,
              }),
              (client) => ({ client: String(client) }),
            ),
        }),
        tool({
          name: "oauth.clients.createHandoff",
          description:
            "Return a browser URL that opens the Register-OAuth-app form for one integration, pre-filled with the non-secret fields (client id, endpoints, grant). Use this for any CONFIDENTIAL OAuth app: the user types the client secret directly in the web UI instead of sending it through the agent. After they register the app, call `oauth.clients.list` to discover its owner and slug, then `oauth.start`.",
          inputSchema: OAuthCreateClientHandoffInputStd,
          outputSchema: OAuthCreateClientHandoffOutputStd,
          // Pure URL builder: no DB write, no token, no secret. This is the SAFE
          // path (it routes the secret to the human in the browser), so it is
          // deliberately NOT approval-gated, mirroring `connections.createHandoff`.
          execute: (input: typeof OAuthCreateClientHandoffInput.Type) => {
            const url = oauthClientCreateHandoffUrl(options.webBaseUrl, options.orgSlug, input);
            return Effect.succeed({
              url,
              instructions:
                "Ask the user to open this URL and register the OAuth app in the Executor web UI, entering the client secret there. Do not ask them to paste the client secret into chat. After they finish, call oauth.clients.list to find the registered client (owner + slug), then oauth.start.",
            });
          },
        }),
        tool({
          name: "oauth.clients.registerDynamic",
          description:
            "Register an OAuth client through RFC 7591 Dynamic Client Registration and save the minted client for later `oauth.start` calls.",
          inputSchema: OAuthRegisterDynamicInputStd,
          outputSchema: OAuthClientOutputRefStd,
          // Same risk class as `oauth.clients.create`: registers a client at a
          // caller-supplied endpoint and persists the minted credentials for
          // later `oauth.start` abuse. Approval-gated. See `oauth.clients.create`.
          annotations: { requiresApproval: true },
          execute: (input: typeof OAuthRegisterDynamicInput.Type, { ctx }) =>
            Effect.map(
              ctx.oauth.registerDynamicClient({
                owner: input.owner as Owner,
                slug: OAuthClientSlug.make(input.slug),
                registrationEndpoint: input.registrationEndpoint,
                authorizationUrl: input.authorizationUrl,
                tokenUrl: input.tokenUrl,
                resource: input.resource ?? null,
                scopes: input.scopes,
                tokenEndpointAuthMethodsSupported: input.tokenEndpointAuthMethodsSupported,
                clientName: input.clientName,
                redirectUri: input.redirectUri,
                originIntegration:
                  input.originIntegration == null
                    ? null
                    : IntegrationSlug.make(input.originIntegration),
              }),
              (client) => ({ client: String(client) }),
            ),
        }),
        tool({
          name: "oauth.clients.remove",
          description:
            "Remove an owner-scoped OAuth client by owner and slug. Existing connections are not cascaded.",
          inputSchema: OAuthRemoveClientInputStd,
          outputSchema: RemovedOutputStd,
          // Removing a client breaks token refresh for every connection that
          // depends on it (a silent DoS) and can force re-auth through an
          // attacker-supplied replacement. Approval-gated, matching v1
          // `sources.bindings.remove`.
          annotations: { requiresApproval: true },
          execute: (input: typeof OAuthRemoveClientInput.Type, { ctx }) =>
            Effect.map(
              ctx.oauth.removeClient(input.owner as Owner, OAuthClientSlug.make(input.slug)),
              () => ({ removed: true }),
            ),
        }),
        tool({
          name: "oauth.probe",
          description:
            "Discover OAuth authorization-server metadata from an issuer or protected-resource URL so client registration can be pre-filled.",
          inputSchema: OAuthProbeInputStd,
          outputSchema: OAuthProbeOutputStd,
          execute: (input: typeof OAuthProbeInput.Type, { ctx }) =>
            Effect.map(ctx.oauth.probe({ url: input.url }), (result) => ({
              authorizationUrl: result.authorizationUrl,
              tokenUrl: result.tokenUrl,
              resource: result.resource ?? null,
              scopesSupported: result.scopesSupported,
              registrationEndpoint: result.registrationEndpoint ?? null,
              tokenEndpointAuthMethodsSupported: result.tokenEndpointAuthMethodsSupported,
              clientIdMetadataDocumentSupported: result.clientIdMetadataDocumentSupported,
            })),
        }),
        tool({
          name: "oauth.start",
          description:
            "Start OAuth through a registered client to mint a connection for an integration. `client_credentials` clients return `connected`; authorization-code clients return an authorization URL and state.",
          inputSchema: OAuthStartInputStd,
          outputSchema: OAuthStartOutputStd,
          // This is the materialization step that turns a registered client
          // into a live connection. For `client_credentials` it completes
          // synchronously (status `connected`) with no browser step, so a
          // prompt-injected call against an attacker-registered client mints a
          // credentialed connection with no human in the loop. The
          // authorization-code path already returns a URL the user must visit,
          // but one gate on the whole tool covers the silent path cleanly.
          annotations: { requiresApproval: true },
          execute: (input: typeof OAuthStartInput.Type, { ctx }) =>
            Effect.map(
              ctx.oauth.start({
                client: OAuthClientSlug.make(input.client),
                clientOwner: input.clientOwner as Owner,
                owner: input.owner as Owner,
                name: ConnectionName.make(input.name),
                integration: IntegrationSlug.make(input.integration),
                template: AuthTemplateSlug.make(input.template),
                identityLabel: input.identityLabel,
                redirectUri: input.redirectUri,
              }),
              (result) =>
                result.status === "connected"
                  ? {
                      status: "connected" as const,
                      connection: connectionToOutput(result.connection),
                    }
                  : {
                      status: "redirect" as const,
                      authorizationUrl: result.authorizationUrl,
                      state: String(result.state),
                    },
            ),
        }),
        tool({
          name: "oauth.cancel",
          description:
            "Cancel an in-flight OAuth authorization-code session by state after the user abandons the flow.",
          inputSchema: OAuthCancelInputStd,
          outputSchema: CancelledOutputStd,
          execute: (input: typeof OAuthCancelInput.Type, { ctx }) =>
            Effect.map(ctx.oauth.cancel(OAuthState.make(input.state)), () => ({ cancelled: true })),
        }),
        tool({
          name: "policies.list",
          description:
            "List tool policies (approve / require_approval / block) for org and user owners, in evaluation order.",
          outputSchema: PoliciesListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.core.policies.list(), (policies) => ({
              policies: policies.map((p) => ({
                id: String(p.id),
                owner: p.owner,
                pattern: p.pattern,
                action: p.action,
                position: p.position,
              })),
            })),
        }),
        tool({
          name: "policies.create",
          description:
            "Create a tool policy. `pattern` matches a tool address tail (`integration.connection.tool`, `integration.*`, `*`); `action` is approve/require_approval/block. `owner` is org (workspace guardrail) or user (personal).",
          inputSchema: PolicyCreateInputStd,
          outputSchema: PolicyOutputStd,
          // A policy decides which tools run without confirmation, so creating
          // one can silence every other approval gate (e.g. `approve *`). It
          // must itself require approval, otherwise prompt-injected code could
          // disable approvals by writing its own bypass policy.
          annotations: { requiresApproval: true },
          execute: (input: typeof PolicyCreateInput.Type, { ctx }) =>
            Effect.map(
              ctx.core.policies.create({
                owner: input.owner as Owner,
                pattern: input.pattern,
                action: input.action,
              }),
              (p) => ({
                id: String(p.id),
                owner: p.owner,
                pattern: p.pattern,
                action: p.action,
                position: p.position,
              }),
            ),
        }),
        tool({
          name: "policies.update",
          description: "Update a tool policy's pattern and/or action by id + owner.",
          inputSchema: PolicyUpdateInputStd,
          outputSchema: PolicyOutputStd,
          // Editing a policy can broaden a pattern or flip an action to
          // `approve`, weakening an approval gate just as creation can, so it
          // requires approval too. See `policies.create`.
          annotations: { requiresApproval: true },
          execute: (input: typeof PolicyUpdateInput.Type, { ctx }) =>
            Effect.map(
              ctx.core.policies.update({
                id: input.id,
                owner: input.owner as Owner,
                pattern: input.pattern,
                action: input.action,
              }),
              (p) => ({
                id: String(p.id),
                owner: p.owner,
                pattern: p.pattern,
                action: p.action,
                position: p.position,
              }),
            ),
        }),
        tool({
          name: "policies.remove",
          description: "Remove a tool policy by id + owner.",
          inputSchema: PolicyRemoveInputStd,
          outputSchema: RemovedOutputStd,
          // Removing a policy can drop a `block` or `require_approval`
          // guardrail, so deletion is also approval-gated. See
          // `policies.create`.
          annotations: { requiresApproval: true },
          execute: (input: typeof PolicyRemoveInput.Type, { ctx }) =>
            Effect.map(
              ctx.core.policies.remove({
                id: input.id,
                owner: input.owner as Owner,
              }),
              () => ({ removed: true }),
            ),
        }),
      ],
    },
  ],
}));
