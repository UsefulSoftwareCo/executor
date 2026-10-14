/**
 * One v1 item becomes v2 resources: an integration an app, a connection a personal account linked
 * to its app for the importing user, a policy per-tool approvals inside its integration's app, a
 * toolkit a scoped MCP connection, an artifact an app's source without a deployment. Each returns
 * the resource it created, or why the item cannot be imported; a defect or storage failure
 * fails the request instead and the item is retried.
 */
import {
  graphqlAppSource,
  generateMcpSource,
  openapiAppSource,
  packageFile,
  type CredentialPlacement,
  type GeneratedAuthMethod,
  type GeneratedHealthCheck,
  type GeneratedToolRules,
} from "@executor-js/app-templates";
import {
  CurrentUserId,
  linkUserAccount,
  organizationOwner,
  type McpConnectionStore,
  type OrganizationId,
} from "@executor-js/hosted-server";
import {
  ConnectionId,
  type ConnectionApp,
  type ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import { personalAccountCreation } from "@executor-js/hosted-server/resource-lifecycle";
import {
  AccountId,
  AppId,
  OAuthGrantImport,
  OAuthRegistration,
  scopeGeneratedPackage,
  SourceFiles,
  StorageHost,
  ToolName,
  type DeployedApp,
  type Executor,
  type OAuthGrantNotImportable,
  type OAuthSetupFailed,
} from "@executor-js/sdk/core";
import { planOperationNames } from "apps/openapi";
import { Effect, Option, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import {
  credentialLike,
  mcpToolName,
  resolvePolicy,
  secretPrefix,
  tokenEndpointAuthMethod,
  toolkitAction,
  type ArtifactBinding,
  type ArtifactRow,
  type ConnectionRow,
  type IntegrationRow,
  type OpenApiOperationRow,
  type PolicyAction,
  type ToolRow,
  type V1Toolkit,
} from "./formats.ts";
import { openapiHealth, v1IntrospectionQuery } from "./health.ts";
import {
  credentialOrigins,
  documentOperations,
  importedDocument,
  operationBaseUrls,
  parseSpec,
  plainHttpHosts,
} from "./openapi.ts";
import {
  artifactPlan,
  artifactRepairNote,
  connectionPlan,
  decodedToolkits,
  firstPartyName,
  type FirstPartyClients,
  grantsNoConnection,
  integrationLabel,
  integrationPlan,
  integrationValues,
  replaces,
  type ConfigSecret,
  type ConnectionPlan,
  toolkitConnections,
  type ImportableIntegration,
} from "./plan.ts";
import type { V1Snapshot, V1Source } from "./source.ts";
import { sourceHash, type ImportStore, type MapResult } from "./store.ts";
import { v1ToolPaths } from "./v1-tool-paths.ts";

/** v1's OAuth callback; imported clients keep it, and v1's edge forwards it to v2. */
export const v1OAuthCallback = "https://executor.sh/api/oauth/callback";

export interface ItemContext {
  readonly executor: Executor;
  /** The importing user's scoped MCP connections in the target organization. */
  readonly connections: McpConnectionStore;
  readonly store: ImportStore;
  /** The product database, on the connection the executor writes with. */
  readonly sql: SqlClient.SqlClient;
  readonly source: V1Source;
  readonly snapshot: V1Snapshot;
  readonly target: { readonly id: OrganizationId; readonly slug: string };
  /** The importing v2 user, who owns every account and links it to its app. */
  readonly user: string;
  /** The operator's OAuth clients v1's first-party connections move to. */
  readonly firstParty: FirstPartyClients;
}

/** An item that cannot be imported, with a reason the user sees. */
export class ItemFailed extends Schema.TaggedError<ItemFailed>()("ItemFailed", {
  reason: Schema.String,
}) {}
const fail = (reason: string) => Effect.fail(new ItemFailed({ reason }));

const imported = (v2Kind: string, v2Id: string, note?: string): MapResult => ({
  status: "imported",
  v2Kind,
  v2Id,
  ...(note === undefined ? {} : { note }),
});

// ---------------------------------------------------------------------------------------------
// Sign-in methods. One integration's app declares every method its connections use.

const methodKey = (method: GeneratedAuthMethod) => JSON.stringify(method);

/** A sign-in method and the values its account takes from v1's configuration, by field. */
interface PlannedMethod {
  readonly method: GeneratedAuthMethod;
  readonly configured: ReadonlyArray<readonly [string, string]>;
}

/**
 * Where an account sends the fixed credentials its method does not replace. v1 sent the fixed
 * values first and the connection's credentials over them, so a placement of the same name wins.
 */
const fixedPlacements = (
  secrets: readonly ConfigSecret[],
  own: readonly { readonly carrier: "header" | "query"; readonly name: string }[],
) => {
  const sent = secrets.filter((secret) => !own.some((placement) => replaces(placement, secret)));
  return {
    placements: sent.map((secret): CredentialPlacement => ({
      carrier: secret.carrier,
      name: secret.name,
      field: secret.field,
    })),
    configured: sent.map((secret) => [secret.field, secret.value] as const),
  };
};

/**
 * The method a connection signs in with, or undefined for one that sends no credentials. An API
 * key's literal values and prefixes that hold a credential become fields like the fixed ones.
 */
const plannedMethod = (plan: ConnectionPlan): PlannedMethod | undefined => {
  const access = plan.access;
  const { secrets } = integrationValues(plan.decoded);
  switch (access.kind) {
    case "none":
      return undefined;
    case "secrets": {
      const configured: Array<readonly [string, string]> = [];
      const placements = access.placements.map((placement): CredentialPlacement => {
        const prefixed =
          placement.prefix !== undefined && secretPrefix(placement.prefix)
            ? { prefixField: `${placement.name} prefix` }
            : { prefix: placement.prefix };
        if (prefixed.prefixField !== undefined && placement.prefix !== undefined)
          configured.push([prefixed.prefixField, placement.prefix]);
        if (placement.literal === undefined)
          return {
            carrier: placement.carrier,
            name: placement.name,
            ...prefixed,
            field: placement.variable ?? "token",
          };
        if (!credentialLike(placement.name, placement.literal))
          return {
            carrier: placement.carrier,
            name: placement.name,
            ...prefixed,
            literal: placement.literal,
          };
        const field = `${placement.carrier} ${placement.name}`;
        configured.push([field, placement.literal]);
        return { carrier: placement.carrier, name: placement.name, ...prefixed, field };
      });
      const fixed = fixedPlacements(secrets, access.placements);
      const all = [...configured, ...fixed.configured];
      return {
        method: {
          kind: "secrets",
          label: "API key",
          fields: [
            ...new Set([
              ...access.items.map(([variable]) => variable),
              ...all.map(([field]) => field),
            ]),
          ],
          placements: [...placements, ...fixed.placements],
        },
        configured: all,
      };
    }
    case "oauth": {
      // v1 signed in at the connection's client's endpoints with the method's scopes, or the ones
      // its authorization URL set, so a reconnect does too; connections whose clients differ get a
      // method each. The account's grant renews as v1 did (`renewal`).
      const { method, client } = access;
      const scopes = [...method.scopes];
      const resource =
        client.resource === null || client.resource === "" ? {} : { resource: client.resource };
      const oauth =
        access.grant === "client_credentials"
          ? {
              grant: "client_credentials",
              tokenUrl: client.token_url,
              scopes,
              tokenEndpointAuthMethod: access.authentication,
              ...resource,
            }
          : access.authorization.kind === "discover"
            ? {
                discover: access.authorization.url,
                ...(scopes.length === 0 ? {} : { scopes }),
              }
            : {
                authorizationUrl: access.authorization.authorizationUrl,
                tokenUrl: client.token_url,
                scopes: [...access.authorization.scopes],
                ...resource,
              };
      // connectionPlan refuses an OAuth connection whose fixed credentials it would not replace.
      return {
        method: { kind: "oauth", oauth, header: method.header, prefix: method.prefix },
        configured: [],
      };
    }
    case "first_party": {
      // v1 signed in at its own app's endpoints, which v2's client of the same name has. The
      // method declares them, so v2 signs it in, renews it and reconnects it with that client;
      // an MCP server names them itself. Its scopes are what v1 asked that app for. A client
      // that allows no scopes (the GitHub App's) asks for none, so an MCP method says so: left
      // to discovery, it would ask for the scopes the server advertises (GitHub's MCP server
      // lists `repo`, `gist` and more), and such a client is not offered for those.
      const { method, client, scopes } = access;
      const oauth =
        plan.decoded.plugin === "mcp"
          ? {
              discover: plan.decoded.config.endpoint,
              ...(scopes.length === 0 && (client.allowedScopes ?? client.defaultScopes).length > 0
                ? {}
                : { scopes: [...scopes] }),
            }
          : {
              authorizationUrl: client.server.authorizationUrl,
              tokenUrl: client.server.tokenUrl,
              scopes: [...scopes],
            };
      return {
        method: { kind: "oauth", oauth, header: method.header, prefix: method.prefix },
        configured: [],
      };
    }
  }
};

/**
 * The app's sign-in methods, which one each importable connection uses, and the values each
 * account takes from v1's configuration. When the app takes accounts at all (another connection
 * signs in, or the integration sends fixed credentials), a connection that sent no credentials of
 * its own gets a method with only the fixed ones: "No credentials" when there are none.
 */
export const appMethods = (
  snapshot: V1Snapshot,
  firstParty: FirstPartyClients,
  integration: IntegrationRow,
) => {
  const methods: Record<string, GeneratedAuthMethod> = {};
  const keys = new Map<string, string>();
  const methodOf = new Map<string, string>();
  const configured = new Map<string, ReadonlyArray<readonly [string, string]>>();
  const plans = snapshot.connections
    .filter((row) => row.integration === integration.slug)
    .flatMap((row) => {
      const plan = connectionPlan(snapshot, firstParty, row);
      return plan.ok ? [plan.value] : [];
    });
  const add = (plan: ConnectionPlan, planned: PlannedMethod) => {
    configured.set(plan.row.row_id, planned.configured);
    const key = methodKey(planned.method);
    const existing = keys.get(key);
    if (existing !== undefined) {
      methodOf.set(plan.row.row_id, existing);
      return;
    }
    // v1 accepted a connection with an empty template slug; a method needs a name.
    const template = plan.row.template === "" ? plan.access.kind : plan.row.template;
    const base =
      plan.access.kind === "oauth" && plan.access.grant === "client_credentials"
        ? `${template}_client_credentials`
        : template;
    let name = base;
    for (let number = 2; Object.hasOwn(methods, name); number++) name = `${base}_${number}`;
    methods[name] = planned.method;
    keys.set(key, name);
    methodOf.set(plan.row.row_id, name);
  };
  for (const plan of plans) {
    const planned = plannedMethod(plan);
    if (planned !== undefined) add(plan, planned);
  }
  const decoded = integrationPlan(integration);
  const secrets = decoded.ok ? integrationValues(decoded.value).secrets : [];
  if (Object.keys(methods).length > 0 || secrets.length > 0) {
    const fixed = fixedPlacements(secrets, []);
    const none: GeneratedAuthMethod = {
      kind: "secrets",
      label: secrets.length === 0 ? "No credentials" : "Fixed credentials",
      fields: fixed.configured.map(([field]) => field),
      placements: fixed.placements,
    };
    for (const plan of plans)
      if (plan.access.kind === "none") add(plan, { method: none, configured: fixed.configured });
    // Fixed credentials without a connection still make the app take an account that holds them.
    if (Object.keys(methods).length === 0) methods.none = none;
  }
  return { methods, methodOf, configured, plans };
};

// ---------------------------------------------------------------------------------------------
// Tool names and approvals.

const rank = { approve: 1, default: 1.5, require_approval: 2, block: 3 } as const;
/**
 * Each tool's v1 policy result, combined across its connections and the v1 names it had: the most
 * restrictive, where a connection without a matching policy keeps the tool's own default.
 * `aliases` maps a dropped v1 name to the name the tool keeps.
 *
 * A toolkit's own policies applied only to calls through the toolkit, but v2 keeps approvals in
 * the app for every caller. A toolkit that asks before a tool it grants therefore makes the app
 * ask; its `approve` never lowers the workspace's result, and its `block` only leaves the tool out
 * of the toolkit's connection.
 */
export const toolActions = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
) => {
  const actions = new Map<string, PolicyAction | "default">();
  const toolkits = decodedToolkits(snapshot);
  for (const tool of tools) {
    const id = `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`;
    const own = resolvePolicy(id, snapshot.policies) ?? "default";
    const action =
      rank[own] < rank.require_approval &&
      toolkits.some((toolkit) => toolkitAction(toolkit, id) === "require_approval")
        ? "require_approval"
        : own;
    const name = Object.hasOwn(aliases, tool.name) ? (aliases[tool.name] ?? tool.name) : tool.name;
    const current = actions.get(name);
    if (current === undefined || rank[action] > rank[current]) actions.set(name, action);
  }
  return actions;
};

const approvalRules = (actions: ReadonlyMap<string, PolicyAction | "default">) => {
  const approvals: Record<string, "always" | "never"> = {};
  const omitted: string[] = [];
  for (const [name, action] of actions) {
    if (action === "block") omitted.push(name);
    else if (action === "approve") approvals[name] = "never";
    else if (action === "require_approval") approvals[name] = "always";
  }
  return { approvals, omitted };
};

const missingNames = (missing: readonly string[]) =>
  `v2 would not provide ${missing.length} of its v1 tools: ${missing
    .slice(0, 10)
    .join(", ")}${missing.length > 10 ? ", …" : ""}.`;

/**
 * Whether v1 renamed an MCP server's tools, the upstream names v1 numbered, the v1 names dropped
 * as aliases, and the v1 names the generated app cannot reproduce. v1's id is the lower snake case
 * name, numbered from `_2` when an earlier tool of the same listing took it; the app maps each
 * numbered name explicitly. v1 sometimes listed one upstream tool under two names; it is kept once,
 * under its lower snake case name, and the other names are aliases (`alias → kept name`). A tool
 * row without the server's own name fails every call in v1 until it lists again, so it is skipped.
 */
export const mcpNaming = (rows: readonly ToolRow[]) => {
  const tools = rows.flatMap((tool) =>
    tool.upstream === null ? [] : [{ ...tool, upstream: tool.upstream }],
  );
  const rename = tools.some((tool) => tool.upstream !== tool.name);
  const exposed = (upstream: string) => (rename ? mcpToolName(upstream) : upstream);
  const overrides: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const missing = new Set<string>();
  // A name another upstream tool takes in lower snake case belongs to that tool.
  const takenByOther = (upstream: string, name: string) =>
    tools.some((other) => other.upstream !== upstream && exposed(other.upstream) === name);
  const upstreams = new Map<string, Set<string>>();
  for (const tool of tools)
    upstreams.set(tool.upstream, (upstreams.get(tool.upstream) ?? new Set()).add(tool.name));
  for (const [upstream, names] of upstreams) {
    const base = exposed(upstream);
    if (names.size > 1) {
      for (const name of names)
        if (name === base) continue;
        else if (takenByOther(upstream, base)) missing.add(name);
        else aliases[name] = base;
      continue;
    }
    for (const name of names) {
      if (base === name) continue;
      const numbered =
        rename &&
        name.startsWith(`${base}_`) &&
        /^[0-9]+$/u.test(name.slice(base.length + 1)) &&
        !takenByOther(upstream, name);
      if (numbered) overrides[upstream] = name;
      else missing.add(name);
    }
  }
  return { rename, overrides, aliases, missing: [...missing] };
};

/** v1 GraphQL names that are not `query.<field>` or `mutation.<field>`. */
export const graphqlMissing = (tools: readonly ToolRow[]) => [
  ...new Set(
    tools
      .filter((tool) => !/^(query|mutation)\.[A-Za-z_][A-Za-z0-9_]*$/u.test(tool.name))
      .map((tool) => tool.name),
  ),
];

const toolNames = (tools: readonly ToolRow[]) => new Set(tools.map((tool) => tool.name));

/**
 * v1's compiled name, by method and document path, for each operation v1 bound without a stored
 * row: a tool it last listed but stored no binding for, which v1 found by compiling the document.
 * An integration with neither rows nor listed tools exposes every operation, as v1 listed for a
 * new connection.
 */
export const compiledTools = (
  document: Record<string, unknown>,
  operations: readonly OpenApiOperationRow[],
  tools: readonly ToolRow[],
): ReadonlyMap<string, string> => {
  const bound = new Set(operations.map((operation) => operation.tool));
  const listed = toolNames(tools);
  const unbound = [...listed].filter((tool) => !bound.has(tool));
  if (operations.length > 0 && unbound.length === 0) return new Map();
  const wanted = operations.length === 0 && listed.size === 0 ? undefined : new Set(unbound);
  return new Map(
    [...v1ToolPaths(document)].filter(([, tool]) => wanted === undefined || wanted.has(tool)),
  );
};

// ---------------------------------------------------------------------------------------------
// Integrations.

/** The v1 reads source generation needs; the audit script passes its own. */
export type GenerationSource = Pick<
  V1Source,
  "tools" | "openApiOperations" | "openApiBinding" | "blob" | "blobMissing"
>;

/**
 * How the generated provider checks accounts, as the audit counts it: v1's check carried over, the
 * MCP server's own, none because v1 declared none or the app takes no account, or why v1's check
 * is not carried over.
 */
export type HealthOutcome =
  | { readonly kind: "request"; readonly identity: boolean }
  | { readonly kind: "graphql" }
  | { readonly kind: "mcp"; readonly declared: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "dropped"; readonly reason: string };

/** An integration's generated app: its files, what the user should know, and its check. */
export interface GeneratedApp {
  readonly files: SourceFiles;
  readonly note: string | undefined;
  readonly health: HealthOutcome;
}

const healthOf = (check: GeneratedHealthCheck | undefined) =>
  check === undefined ? {} : { health: check };

/** An integration's app source, generated from v1's rows without writing anything. */
export const generate = (
  context: { readonly snapshot: V1Snapshot; readonly source: GenerationSource },
  integration: IntegrationRow,
  decoded: ImportableIntegration,
  methods: Readonly<Record<string, GeneratedAuthMethod>>,
) =>
  Effect.gen(function* () {
    const name = integrationLabel(integration);
    const { tenant, member } = context.snapshot;
    const accounts = Object.keys(methods).length > 0;
    // Credentials in v1's configuration are account fields; only the rest is written to source.
    const { headers, queryParams } = integrationValues(decoded);
    switch (decoded.plugin) {
      case "mcp": {
        const tools = yield* context.source.tools(tenant, member, integration.slug);
        const { rename, overrides, aliases, missing } = mcpNaming(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const rules: GeneratedToolRules = {
          ...(rename ? { names: { kind: "lower_snake", overrides } } : {}),
          ...approvalRules(toolActions(context.snapshot, integration, tools, aliases)),
        };
        const dropped = Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1));
        const generated = yield* generateMcpSource(
          name,
          decoded.config.endpoint,
          { kind: "methods", methods },
          { headers, queryParams, tools: rules },
        );
        return {
          files: generated.files,
          note:
            dropped.length === 0
              ? undefined
              : `v1 listed ${dropped.length === 1 ? "a tool" : "tools"} under two names; ${dropped
                  .map(([alias, kept]) => `${alias} is now ${kept}`)
                  .join(", ")}.`,
          // v1's MCP check only listed tools, whatever it declared, as mcpHealth does.
          health: accounts
            ? { kind: "mcp" as const, declared: integration.health_check !== null }
            : { kind: "none" as const },
        } satisfies GeneratedApp;
      }
      case "graphql": {
        const tools = yield* context.source.tools(tenant, member, integration.slug);
        const missing = graphqlMissing(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const check: GeneratedHealthCheck | undefined =
          accounts && decoded.healthCheck
            ? { kind: "graphql", query: v1IntrospectionQuery }
            : undefined;
        const generated = yield* graphqlAppSource({
          name,
          url: decoded.config.endpoint,
          methods,
          headers,
          queryParams,
          tools: {
            names: { kind: "graphql_path" },
            ...approvalRules(toolActions(context.snapshot, integration, tools)),
          },
          ...healthOf(check),
        });
        return {
          files: generated.files,
          note: undefined,
          health: check === undefined ? { kind: "none" as const } : { kind: "graphql" as const },
        } satisfies GeneratedApp;
      }
      case "openapi": {
        const stored = yield* context.source.blob(tenant, "openapi", `spec/${decoded.specHash}`);
        if (Option.isNone(stored)) return yield* fail(context.source.blobMissing);
        const parsed = parseSpec(stored.value);
        if (!parsed.ok) return yield* fail(parsed.reason);
        const { document } = parsed;
        const operations = yield* context.source.openApiOperations(tenant, integration.slug);
        const tools = yield* context.source.tools(tenant, member, integration.slug);
        const prepared = importedDocument(
          document,
          operations,
          compiledTools(document, operations, tools),
        );
        // v1 sent each operation to its own server unless the integration set a base URL, with the
        // account's credentials on every one. The app does the same when those servers are one
        // service's hosts, and declares each of them for the account's credentials.
        const servers = operationBaseUrls(decoded.config, prepared.document);
        if (!servers.ok) return yield* fail(servers.reason);
        const allowed = credentialOrigins(servers.urls);
        if (!allowed.ok)
          return yield* fail(
            `Its operations call hosts of different services (${allowed.hosts.join(", ")}), and an imported app sends an account's credentials only to one service's hosts.`,
          );
        const { origins } = allowed;
        // v1 also sent the credentials over plain HTTP when a server named it; an app that sends
        // them to several hosts does so only over HTTPS.
        const insecure = accounts && origins.length > 1 ? plainHttpHosts(origins) : [];
        if (insecure.length > 0)
          return yield* fail(
            `Its operations call ${insecure.join(", ")} over plain HTTP, and an imported app sends an account's credentials to more than one host only over HTTPS.`,
          );
        // v2's names for every operation, as liveOpenapiRouter plans them, mapped to v1's.
        const names: Record<string, string> = {};
        for (const operation of planOperationNames(documentOperations(prepared)))
          if (operation.v1 !== undefined) names[operation.name] = operation.v1;
        const exposed = new Set(Object.values(names));
        // Every tool v1 bound or last listed.
        const missing = [
          ...new Set([...operations.map((operation) => operation.tool), ...toolNames(tools)]),
        ].filter((tool) => !exposed.has(tool));
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const spec = decoded.healthCheck;
        const planned =
          !accounts || spec === undefined
            ? undefined
            : openapiHealth({
                config: decoded.config,
                spec,
                binding: yield* context.source.openApiBinding(
                  tenant,
                  integration.slug,
                  spec.operation,
                ),
                origins,
              });
        const generated = yield* openapiAppSource({
          name,
          document: prepared.document,
          baseUrl: decoded.config.baseUrl,
          allowedOrigins: origins,
          methods,
          headers,
          queryParams,
          tools: {
            names: { kind: "map", names },
            ...approvalRules(toolActions(context.snapshot, integration, tools)),
          },
          ...healthOf(planned?.ok === true ? planned.check : undefined),
        });
        return {
          files: generated.files,
          note: undefined,
          health:
            planned === undefined
              ? { kind: "none" as const }
              : planned.ok
                ? {
                    kind: "request" as const,
                    identity:
                      planned.check.kind === "request" && planned.check.identity !== undefined,
                  }
                : { kind: "dropped" as const, reason: planned.reason },
        } satisfies GeneratedApp;
      }
    }
  }).pipe(Effect.catchTag("TemplateError", (error) => fail(error.reason)));

/** Deploy under the integration's name, then a numbered name when the organization has it. */
const deployNamed = (context: ItemContext, name: string, files: SourceFiles) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const candidate = attempt === 1 ? name : `${name.slice(0, 110)} (v1 ${attempt})`;
      const scoped = yield* scopeGeneratedPackage(files, context.target.slug, candidate).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      );
      const deployed = yield* context.executor.apps
        .deploy({ owner, name: candidate, files: scoped })
        .pipe(
          Effect.map((result) => Option.some(result.app)),
          Effect.catchTags({
            AppNameTaken: () => Effect.succeed(Option.none<DeployedApp>()),
            AppSlugTaken: () => Effect.succeed(Option.none<DeployedApp>()),
          }),
        );
      if (Option.isSome(deployed)) return deployed.value;
    }
    return yield* fail("Every name for this app is taken in the organization.");
  });

export const importIntegration = (
  context: ItemContext,
  integration: IntegrationRow,
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(integration);
    if (!plan.ok) return yield* fail(plan.reason);
    const { methods } = appMethods(context.snapshot, context.firstParty, integration);
    const generated = yield* generate(context, integration, plan.value, methods);
    const owner = organizationOwner(context.target.id);
    const app =
      existing === undefined
        ? yield* deployNamed(context, integrationLabel(integration), generated.files)
        : (yield* context.executor.apps.deploy({
            owner,
            app: existing,
            files: yield* scopeGeneratedPackage(
              generated.files,
              context.target.slug,
              integrationLabel(integration),
            ).pipe(Effect.catch(() => fail("The app package could not be named."))),
          })).app;
    return imported("app", app.id, generated.note);
  }).pipe(
    Effect.catchTags({
      // The build's message names its stage and the failure in the generated source. Builds bind
      // no accounts, so it holds no credentials.
      DeploymentBuildFailed: (error) => fail(`The generated app did not build. ${error.message}`),
      BuildMemoryExceeded: () => fail("The generated app is too large to build."),
      AppNotFound: () => fail("Its imported app was removed."),
    }),
    Effect.provideService(CurrentUserId, context.user),
  );

// ---------------------------------------------------------------------------------------------
// Connections.

/**
 * Why a copied sign-in could not be set up, in the words of what to do next. An outage clears up
 * by itself, so support can retry it; the rest need a new sign-in.
 */
const oauthSetupReason = (reason: OAuthSetupFailed["reason"]) =>
  reason === "service_unavailable" || reason === "rate_limited"
    ? "The service did not respond while its sign-in was set up. Contact support if you need it."
    : reason === "discovery_missing" ||
        reason === "discovery_invalid" ||
        reason === "discovery_blocked"
      ? "The service no longer says how to sign in to it. Reconnect it in v2."
      : "Its sign-in could not be carried over to v2. Reconnect it in v2.";

/** Why a first-party sign-in cannot move to v2's client of the same name, as the user reads it. */
const firstPartyRefusal = (
  name: string,
  client: { readonly placement: { readonly hosts: readonly string[] } },
  hosts: readonly string[],
  error: Pick<OAuthGrantNotImportable, "reason" | "unreachable">,
) => {
  const only = `Executor v2's own ${name} app sends its tokens only to ${client.placement.hosts.join(", ")}`;
  const unreachable = error.unreachable ?? [];
  return error.reason === "unavailable"
    ? `It signed in through Executor's own ${name} app, which Executor v2 does not offer yet. Reconnect it in v2.`
    : error.reason === "scopes"
      ? `It was granted permissions Executor v2's own ${name} app does not allow. Reconnect it in v2.`
      : error.reason === "hosts"
        ? unreachable.length === 0 || unreachable.length === hosts.length
          ? `${only}, and its integration calls none of them. Reconnect it in v2.`
          : `${only}, and its integration also calls ${unreachable.join(", ")}, where its calls would be refused. Reconnect it in v2.`
        : `Its integration does not sign in where Executor v2's own ${name} app does. Reconnect it in v2.`;
};

const secret = (context: ItemContext, itemId: string) =>
  context.source
    .secret({ tenant: context.snapshot.tenant, subject: context.snapshot.member, itemId })
    .pipe(
      Effect.flatMap((value) =>
        value === undefined || value === ""
          ? fail("Its saved credential could not be found in v1. Reconnect it in v2.")
          : Effect.succeed(Redacted.make(value)),
      ),
    );

/** The personal account's name; an org connection yields its name to a personal one. */
export const accountLabel = (snapshot: V1Snapshot, row: ConnectionRow) =>
  row.owner === "org" &&
  snapshot.connections.some(
    (other) =>
      other.owner === "user" && other.integration === row.integration && other.name === row.name,
  )
    ? `${row.name} (workspace)`
    : row.name;

/** Save the connection's account; the map row commits with it. */
export const importAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
) =>
  Effect.gen(function* () {
    const requirement = app.requirements.accounts.service;
    if (requirement === undefined) return yield* fail("Its imported app takes no account.");
    const planned = appMethods(context.snapshot, context.firstParty, plan.integration);
    const method = planned.methodOf.get(plan.row.row_id);
    if (method === undefined) return yield* fail("Its sign-in method is not in the imported app.");
    const owner = organizationOwner(context.target.id);
    const label = accountLabel(context.snapshot, plan.row);
    const access = plan.access;
    if (access.kind === "first_party") {
      const accessToken = yield* secret(context, access.accessItem);
      const refreshToken =
        plan.row.refresh_item_id === null
          ? undefined
          : yield* secret(context, plan.row.refresh_item_id);
      const appName = firstPartyName(access.client.id);
      const hosts = requirement.definition.hosts ?? [];
      const account = yield* context.executor[OAuthGrantImport]
        .importOAuthGrant({
          owner,
          provider: requirement.provider,
          method,
          label,
          redirectUri: v1OAuthCallback,
          firstParty: access.client.id,
          hosts,
          accessToken,
          refreshToken,
          ...(plan.row.expires_at === null ? {} : { expiresAt: plan.row.expires_at }),
          renewal: access.renewal,
        })
        .pipe(
          personalAccountCreation(context.user),
          Effect.catchTag("OAuthSetupFailed", (error) => fail(oauthSetupReason(error.reason))),
          Effect.catchTag("AuthMethodInvalid", () =>
            fail("Its sign-in method is not in the imported app."),
          ),
          Effect.catchTag("OAuthGrantNotImportable", (error) =>
            fail(firstPartyRefusal(appName, access.client, hosts, error)),
          ),
        );
      yield* record(imported("account", account.id));
      return account.id;
    }
    if (access.kind !== "oauth") {
      // Values from v1's configuration first, then the connection's own from v1's Vault.
      const fields: Record<string, string> = Object.fromEntries(
        planned.configured.get(plan.row.row_id) ?? [],
      );
      if (access.kind === "secrets")
        for (const [variable, item] of access.items)
          fields[variable] = Redacted.value(yield* secret(context, item));
      return yield* context.executor[StorageHost].transaction(
        Effect.gen(function* () {
          const account = yield* context.executor.managedAccounts
            .add({
              owner,
              provider: requirement.provider,
              method,
              label,
              fields: Redacted.make(fields),
            })
            .pipe(personalAccountCreation(context.user));
          yield* record(imported("account", account.id));
          return account.id;
        }),
      );
    }
    const { client, grant } = access;
    const clientSecret =
      client.client_secret_item_id === null
        ? undefined
        : yield* secret(context, client.client_secret_item_id);
    const registration = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
      client_id: client.client_id,
      token_endpoint_auth_method:
        clientSecret === undefined
          ? "none"
          : (tokenEndpointAuthMethod(client.token_endpoint_auth_method) ?? "client_secret_post"),
      ...(clientSecret === undefined ? {} : { client_secret: Redacted.value(clientSecret) }),
    }).pipe(Effect.catch(() => fail("Its OAuth client could not be read.")));
    const accessToken = yield* secret(context, access.accessItem);
    const refreshToken =
      grant === "authorization_code" && plan.row.refresh_item_id !== null
        ? yield* secret(context, plan.row.refresh_item_id)
        : undefined;
    const account = yield* context.executor[OAuthGrantImport]
      .importOAuthGrant({
        owner,
        provider: requirement.provider,
        method,
        label,
        ...(grant === "authorization_code"
          ? { redirectUri: client.origin_redirect_uri ?? v1OAuthCallback }
          : {}),
        client: Redacted.make(registration),
        accessToken,
        refreshToken,
        ...(plan.row.expires_at === null ? {} : { expiresAt: plan.row.expires_at }),
        renewal: access.renewal,
      })
      .pipe(
        personalAccountCreation(context.user),
        Effect.catchTag("OAuthSetupFailed", (error) => fail(oauthSetupReason(error.reason))),
        Effect.catchTag("AuthMethodInvalid", () =>
          fail("Its sign-in method is not in the imported app."),
        ),
      );
    // Discovery ran outside a transaction; the account is recorded as soon as it exists.
    yield* record(imported("account", account.id));
    return account.id;
  }).pipe(Effect.provideService(CurrentUserId, context.user));

/**
 * Link the connection's account to its app's `service` requirement for the importing user, as
 * linking it in v2 does. The requirement takes many accounts, so every imported connection of an
 * integration stays usable. Linking again changes nothing, so a retried item does not duplicate it.
 */
export const linkConnectionAccount = (
  context: ItemContext,
  app: Pick<DeployedApp, "id">,
  account: AccountId,
) =>
  linkUserAccount(context.executor, context.sql, {
    app: app.id,
    requirement: "service",
    account,
    subject: context.user,
  });

// ---------------------------------------------------------------------------------------------
// Toolkits.

type RunTarget = ConnectionApp["runsAs"][number];

/**
 * What an earlier item request imported: an integration's app, and a connection's account and the
 * target its tools run as (its linked account, or the app itself for a public app).
 */
export interface ImportedLookup {
  readonly app: (
    integration: IntegrationRow,
  ) => Effect.Effect<string | undefined, V1ImportUnavailable>;
  readonly connection: (
    connection: ConnectionRow,
  ) => Effect.Effect<
    { readonly target: RunTarget; readonly account: string | null } | undefined,
    V1ImportUnavailable
  >;
}

/**
 * The import map's view of earlier item requests. A connection is done once its `profile` row is:
 * the row keeps the kind it had when imports made a profile per connection, so imports started
 * then still read. Its `v2_kind` is `app` for a public app's connection, whose tools run as the
 * app; otherwise the connection's account, recorded in its `connection` row, is linked to the app
 * and is what its tools run as. Its `v2_id` is the linked account, or, in a row from before
 * profiles were removed, the profile, which the item's result replaces with that account.
 */
export const mapLookup = (store: ImportStore): ImportedLookup => ({
  app: (integration) =>
    store
      .find("integration", integration.row_id)
      .pipe(
        Effect.map((found) =>
          found?.status === "imported" && found.v2_id !== null ? found.v2_id : undefined,
        ),
      ),
  connection: (connection) =>
    Effect.gen(function* () {
      const linked = yield* store.find("profile", connection.row_id);
      if (linked?.status !== "imported" || linked.v2_id === null) return undefined;
      if (linked.v2_kind === "app") return { target: { kind: "app" } as const, account: null };
      const account = yield* store.find("connection", connection.row_id);
      if (account?.status !== "imported" || account.v2_id === null) return undefined;
      return {
        target: { kind: "account", id: AccountId.make(account.v2_id) } as const,
        account: account.v2_id,
      };
    }),
});

const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "account" && a.id === b.id;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * A toolkit's scoped MCP connection: for each imported app whose tools it granted, the tools v1
 * served through it (`selected`, by the app's names) and the linked accounts of the connections it
 * granted (or the app itself, for a public app). v2 selects an app's tools and accounts
 * separately, so a tool v1 granted for only some of those connections becomes available through
 * all of them; the note says so.
 */
export const toolkitPolicy = (
  context: { readonly snapshot: V1Snapshot; readonly source: Pick<V1Source, "tools"> },
  lookup: ImportedLookup,
  toolkit: V1Toolkit,
) =>
  Effect.gen(function* () {
    const { snapshot, source } = context;
    const apps: ConnectionApp[] = [];
    const notes: string[] = [];
    const missingApps: string[] = [];
    const missingConnections = new Set<string>();
    const blockedElsewhere = new Set<string>();
    const widened: string[] = [];
    const reached = toolkitConnections(snapshot, toolkit);
    for (const integration of snapshot.integrations) {
      if (!reached.some((connection) => connection.integration === integration.slug)) continue;
      const appId = yield* lookup.app(integration);
      const label = integrationLabel(integration);
      if (appId === undefined) {
        missingApps.push(label);
        continue;
      }
      const tools = yield* source.tools(snapshot.tenant, snapshot.member, integration.slug);
      const aliases = integration.plugin_id === "mcp" ? mcpNaming(tools).aliases : {};
      const omitted = new Set(
        approvalRules(toolActions(snapshot, integration, tools, aliases)).omitted,
      );
      const names = new Set<string>();
      const granted = new Map<string, ConnectionRow>();
      const pairs = new Set<string>();
      for (const tool of tools) {
        const action = toolkitAction(
          toolkit,
          `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`,
        );
        if (action === undefined || action === "block") continue;
        const name = Object.hasOwn(aliases, tool.name)
          ? (aliases[tool.name] ?? tool.name)
          : tool.name;
        if (omitted.has(name)) {
          blockedElsewhere.add(`${label} ${name}`);
          continue;
        }
        const connection = snapshot.connections.find(
          (candidate) =>
            candidate.integration === integration.slug &&
            candidate.owner === tool.owner &&
            candidate.name === tool.connection,
        );
        if (connection === undefined) continue;
        names.add(name);
        granted.set(connection.row_id, connection);
        pairs.add(`${connection.row_id} ${name}`);
      }
      if (names.size === 0) continue;
      const targets: RunTarget[] = [];
      for (const connection of granted.values()) {
        const target = (yield* lookup.connection(connection))?.target;
        if (target === undefined) missingConnections.add(`${label} ${connection.name}`);
        else if (!targets.some((other) => sameTarget(other, target))) targets.push(target);
      }
      const [first, ...rest] = targets;
      if (first === undefined) continue;
      if (names.size * granted.size > pairs.size) widened.push(label);
      apps.push({
        app: AppId.make(appId),
        runsAs: [first, ...rest],
        tools: { kind: "selected", names: [...names].sort().map((name) => ToolName.make(name)) },
      });
    }
    if (reached.length === 0) notes.push(grantsNoConnection);
    if (missingApps.length > 0) notes.push(`Not imported, so left out: ${missingApps.join(", ")}.`);
    if (missingConnections.size > 0)
      notes.push(
        `${plural(missingConnections.size, "connection was", "connections were")} not imported and ${missingConnections.size === 1 ? "is" : "are"} left out: ${[...missingConnections].join(", ")}.`,
      );
    if (blockedElsewhere.size > 0)
      notes.push(
        `${plural(blockedElsewhere.size, "tool", "tools")} v1 allowed only through this toolkit ${blockedElsewhere.size === 1 ? "is" : "are"} blocked in the workspace, so ${blockedElsewhere.size === 1 ? "it is" : "they are"} left out: ${[...blockedElsewhere].sort().join(", ")}.`,
      );
    if (widened.length > 0)
      notes.push(
        `v2 grants an app's selected tools through every selected account, so some tools are now available through more accounts of ${widened.join(", ")} than in v1.`,
      );
    if (toolkit.access.some((pattern) => pattern.split(".")[0] === "executor"))
      notes.push("It granted v1's built-in tools, which v2 does not have.");
    return { policy: { apps } satisfies ConnectionPolicy, notes };
  });

/** The connection's id: stable for the toolkit and organization, so a retry updates it. */
export const toolkitConnectionId = (organization: string, toolkit: V1Toolkit) =>
  sourceHash([organization, toolkit.row.row_id]).pipe(
    Effect.map((hash) => ConnectionId.make(`v1-${hash.slice(0, 40)}`)),
  );

/** Create or update the toolkit's scoped MCP connection, owned by the importing user. */
export const importToolkit = (context: ItemContext, toolkit: V1Toolkit) =>
  Effect.gen(function* () {
    const { policy, notes } = yield* toolkitPolicy(context, mapLookup(context.store), toolkit);
    const owner = { userId: context.user, resource: context.target.id };
    const id = yield* toolkitConnectionId(context.target.id, toolkit);
    const name = (toolkit.data.name.trim() === "" ? toolkit.data.slug : toolkit.data.name).slice(
      0,
      80,
    );
    const existing = yield* context.connections.list(owner);
    const saved = existing.some((connection) => connection.id === id)
      ? yield* context.connections.update(owner, { id, name, policy })
      : yield* context.connections.create(owner, { id, name, policy });
    return imported("mcp_connection", saved.id, notes.length === 0 ? undefined : notes.join(" "));
  }).pipe(
    Effect.catchTags({
      ConnectionIdTaken: () => fail("Its MCP connection was removed in v2."),
      ConnectionNotFound: () => fail("Its MCP connection was removed in v2."),
    }),
  );

// ---------------------------------------------------------------------------------------------
// Artifacts.

/** Where one role of an artifact's code maps to in v2, or why it does not. */
export interface ArtifactRoleMapping {
  readonly role: string;
  readonly integration: string;
  readonly v1: ArtifactBinding | null;
  readonly app: { readonly id: string; readonly name: string } | null;
  readonly account: string | null;
  readonly problem: string | null;
}

/** Each role's imported app and linked account, read from the import map. */
export const artifactMapping = (
  snapshot: Pick<V1Snapshot, "integrations" | "connections">,
  lookup: ImportedLookup,
  row: ArtifactRow,
) =>
  Effect.gen(function* () {
    const planned = artifactPlan(snapshot, row);
    const roles = yield* Effect.forEach(planned.roles, ({ use, integration, connection }) =>
      Effect.gen(function* () {
        const mapping = (
          rest: Partial<Omit<ArtifactRoleMapping, "role" | "integration" | "v1">>,
        ): ArtifactRoleMapping => ({
          role: use.role,
          integration: use.integration,
          v1: use.binding ?? null,
          app: null,
          account: null,
          problem: null,
          ...rest,
        });
        if (integration === undefined)
          return mapping({ problem: "Its integration no longer exists in v1." });
        const appId = yield* lookup.app(integration);
        if (appId === undefined) return mapping({ problem: "Its integration was not imported." });
        const app = { id: appId, name: integrationLabel(integration) };
        if (use.binding === undefined)
          return mapping({ app, problem: "v1 bound no connection to it." });
        if (connection === undefined)
          return mapping({ app, problem: "Its connection no longer exists in v1." });
        const imported = yield* lookup.connection(connection);
        if (imported === undefined)
          return mapping({ app, problem: "Its connection was not imported." });
        return mapping({ app, account: imported.account });
      }),
    );
    return { roles, builtIn: planned.builtIn };
  });

const commentText = (text: string) => text.replace(/\*\//g, "*\\/");
const htmlText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The artifact's app package: its v1 code unchanged as the page component, the page and package
 * scaffolding, an app with no tools yet, and `v1-artifact.json` with each role's mapping.
 */
export const artifactFiles = (
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
) => {
  const title = row.title.trim() === "" ? "Artifact" : row.title;
  return [
    packageFile(title, { react: "^19.2.0", "react-dom": "^19.2.0" }),
    {
      path: "index.ts",
      content: `import { defineApp, router } from "apps";

/**
 * Imported from the Executor v1 artifact ${commentText(JSON.stringify(title))}. Its page,
 * ui/artifact.tsx, called other integrations' tools from the browser (\`tools.<integration>...\`),
 * and a v2 app's page calls only its own app's tools. Add tools here that do what the page needs,
 * then rewrite the page to call them through \`apps/client\`. v1-artifact.json lists the imported
 * app and account each \`tools.<role>\` call used.
 */
export default defineApp({}, { tools: router({}) });
`,
    },
    {
      path: "ui/index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlText(title)}</title>
    <script type="module" src="./main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
    },
    {
      path: "ui/main.tsx",
      content: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// v1 ran artifact.tsx with its globals in scope (React hooks, TanStack Query, its UI components
// and \`tools\`) and rendered its \`App\`. Import what it uses there and export \`App\`.
import { App } from "./artifact.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    { path: "ui/artifact.tsx", content: row.code },
    {
      path: "v1-artifact.json",
      content: `${JSON.stringify(
        {
          title: row.title,
          description: row.description,
          builtInTools: mapping.builtIn,
          roles: Object.fromEntries(
            mapping.roles.map(({ role, ...rest }) => [role, rest] as const),
          ),
        },
        null,
        2,
      )}\n`,
    },
  ];
};

/** What the user should know: what needs repair, and where each role's calls now go. */
export const artifactNote = (mapping: {
  readonly roles: readonly ArtifactRoleMapping[];
  readonly builtIn: boolean;
}) => {
  const mapped = mapping.roles.filter((role) => role.problem === null);
  const unmapped = mapping.roles.filter((role) => role.problem !== null);
  return [
    artifactRepairNote,
    ...(mapped.length === 0
      ? []
      : [
          `Its calls map to ${mapped
            .map(
              (role) =>
                `${role.role} → ${role.app?.name ?? role.integration} (${role.v1?.connection ?? "no connection"})`,
            )
            .join(", ")}.`,
        ]),
    ...unmapped.map((role) => `${role.role}: ${role.problem}`),
    ...(mapping.builtIn ? ["It also calls v1's built-in tools, which v2 does not have."] : []),
  ].join(" ");
};

/**
 * Save the artifact as an app without a deployment: `apps.create` keeps its source and builds
 * nothing, so it does not run until it is repaired. An earlier import's app gets a new commit.
 */
export const importArtifact = (
  context: ItemContext,
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    const title = row.title.trim() === "" ? "Artifact" : row.title;
    const files = yield* Schema.decodeUnknownEffect(SourceFiles)(artifactFiles(row, mapping)).pipe(
      Effect.catch(() => fail("Its source is too large for an app.")),
    );
    const note = artifactNote(mapping);
    if (existing !== undefined) {
      const updated = yield* Effect.gen(function* () {
        const workspace = yield* context.executor.apps.workspace({ app: existing, owner });
        const scoped = yield* scopeGeneratedPackage(files, context.target.slug, title).pipe(
          Effect.catch(() => fail("The app package could not be named.")),
        );
        yield* context.executor.apps.commit({
          app: existing,
          owner,
          expected: workspace.revision.commit,
          files: scoped,
          message: "Update from the Executor v1 artifact",
        });
        return Option.some(existing);
      }).pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(Option.none<AppId>())));
      if (Option.isSome(updated)) return { ...imported("undeployed_app", updated.value, note) };
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      const candidate =
        attempt === 1 ? title.slice(0, 120) : `${title.slice(0, 110)} (v1 ${attempt})`;
      const scoped = yield* scopeGeneratedPackage(files, context.target.slug, candidate).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      );
      const created = yield* context.executor.apps
        .create({ owner, name: candidate, files: scoped })
        .pipe(
          Effect.map((app) => Option.some(app.id)),
          Effect.catchTags({
            AppNameTaken: () => Effect.succeed(Option.none<AppId>()),
            AppSlugTaken: () => Effect.succeed(Option.none<AppId>()),
          }),
        );
      if (Option.isSome(created)) return imported("undeployed_app", created.value, note);
    }
    return yield* fail("Every name for this app is taken in the organization.");
  }).pipe(Effect.provideService(CurrentUserId, context.user));
