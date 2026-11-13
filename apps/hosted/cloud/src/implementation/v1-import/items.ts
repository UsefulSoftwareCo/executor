/**
 * One v1 item becomes v2 resources: an integration an app shared with everyone, an org connection
 * the owner's account linked to its app for everyone and a member's connection their own account
 * linked for them (decision 9), a policy per-tool approvals inside its integration's app, a toolkit
 * a scoped MCP connection for each member it reaches (decision 11), an artifact an app's source
 * without a version. Each returns the resource it created, or why the item cannot be imported; a
 * defect or storage failure fails the step instead and the item is retried.
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
  linkAppAccount,
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
import {
  personalAccountCreation,
  sharedAppCreation,
} from "@executor-js/hosted-server/resource-lifecycle";
import {
  AccountId,
  AppId,
  appSlug,
  appSlugFits,
  OAuthGrantImport,
  OAuthRegistration,
  scopeGeneratedPackage,
  SourceFiles,
  StorageHost,
  ToolName,
  type AccountRequirement,
  type DeployedApp,
  type Executor,
  type ImportOAuthGrant,
  type OAuthGrantNotImportable,
  type OwnerId,
  type OAuthSetupFailed,
} from "@executor-js/sdk/core";
import { OpenapiCompileError, openapiOperationNames } from "apps/openapi";
import { Effect, Option, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1StaleCategory } from "../../contracts/v1-import-run.ts";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import {
  credentialLike,
  failingInV1,
  itemOwner,
  mcpToolName,
  policyResolver,
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
  importedDocument,
  operationBaseUrls,
  parseSpec,
  plainHttpHosts,
  withoutOperations,
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
  type Unsupported,
} from "./plan.ts";
import type { V1Snapshot, V1Source } from "./source.ts";
import {
  blockYamlDocument,
  type Entries,
  microsoftGraphFormat,
  parsedDocument,
} from "./stored-document.ts";
import {
  sourceHash,
  toolkitCopyConnectionId,
  toolkitCopyId,
  type ImportStore,
  type MapResult,
} from "./store.ts";
import { v1ToolPaths } from "./v1-tool-paths.ts";

/** v1's OAuth callback; imported clients keep it, and v1's edge forwards it to v2. */
export const v1OAuthCallback = "https://executor.sh/api/oauth/callback";

export interface ItemContext {
  readonly executor: Executor;
  /** Members' scoped MCP connections, which toolkits become. */
  readonly connections: McpConnectionStore;
  readonly store: ImportStore;
  /** The product database, on the connection the executor writes with. */
  readonly sql: SqlClient.SqlClient;
  readonly source: V1Source;
  readonly snapshot: V1Snapshot;
  readonly target: { readonly id: OrganizationId; readonly slug: string };
  /** The v2 owner, who creates the organization's apps and owns its accounts. */
  readonly owner: string;
  /** Each imported member's v2 user, by WorkOS user id. */
  readonly users: ReadonlyMap<string, string>;
  /** The operator's OAuth clients v1's first-party connections move to. */
  readonly firstParty: FirstPartyClients;
}

/** The v1 rows a connection's account is decided from. */
export type ConnectionSnapshot = Pick<
  V1Snapshot,
  "tenant" | "subjects" | "integrations" | "connections" | "clients"
>;

/** The v1 rows an item reads are org rows or one member's own (`subject`). */
type Owned = { readonly owner: "org" | "user"; readonly subject: string };

/**
 * The v2 user an org row or a member's row acts as: the owner for the organization's, the member
 * for theirs. A row of anyone else is never read (`readSnapshot`), so it has none.
 */
export const actorOf = (context: Pick<ItemContext, "owner" | "users">, row: Owned) =>
  row.owner === "org" ? context.owner : context.users.get(row.subject);

/** Org rows, and the rows of one member when given. */
export const visibleTo = (member: string | undefined) => (row: Owned) =>
  row.owner === "org" || (member !== undefined && row.subject === member);

/**
 * An item that cannot be imported, with a reason the user sees. `vault` marks a secret v1's Vault
 * did not return: missing, or unavailable after retries. With `stale`, v1 cannot run it either:
 * it is skipped and reported, and does not block its organization (decision 20). Without, it
 * blocks the organization.
 */
export class ItemFailed extends Schema.TaggedError<ItemFailed>()("ItemFailed", {
  reason: Schema.String,
  vault: Schema.optional(Schema.Literals(["missing", "unavailable"])),
  stale: Schema.optional(V1StaleCategory),
  /** The service did not respond: the item moves when tried again. */
  outage: Schema.optional(Schema.Literal(true)),
}) {}
const fail = (reason: string) => Effect.fail(new ItemFailed({ reason }));
const failStale = (stale: V1StaleCategory, reason: string) =>
  Effect.fail(new ItemFailed({ reason, stale }));
/** Fail with a plan's refusal, keeping whether it is stale. */
export const refused = (plan: Unsupported) =>
  Effect.fail(
    new ItemFailed({ reason: plan.reason, ...(plan.stale === null ? {} : { stale: plan.stale }) }),
  );

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
 * key's literal values and prefixes that hold a credential become fields like the fixed
 * credentials in `secrets`, which its account also holds.
 */
const plannedMethod = (
  plan: ConnectionPlan,
  secrets: readonly ConfigSecret[],
): PlannedMethod | undefined => {
  const access = plan.access;
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
      // The fixed credentials go in the app's fixed account (`appMethods`).
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
 * A fixed credential the app leaves out: its value is the client ID or client secret of the OAuth
 * client one of the integration's connections signs in with, which that sign-in already sends
 * (decision 22).
 */
export interface DroppedFixed {
  readonly secret: ConfigSecret;
  readonly reason: "oauth_client_id" | "oauth_client_secret";
}

/**
 * The integration's fixed credentials that repeat one of its OAuth connections' own client ID or
 * client secret, as when a client's credentials were pasted as headers. A client secret is read
 * from v1's Vault as the connection's import reads it, compared in memory and kept nowhere.
 */
export const redundantFixed = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<
      V1Snapshot,
      "tenant" | "subjects" | "integrations" | "connections" | "clients"
    >;
    readonly firstParty: FirstPartyClients;
  },
  integration: IntegrationRow,
) =>
  Effect.gen(function* () {
    const decoded = integrationPlan(integration);
    if (!decoded.ok) return [];
    const { secrets } = integrationValues(decoded.value);
    if (secrets.length === 0) return [];
    const clients: Array<{ readonly id: string; readonly secret: string | undefined }> = [];
    for (const row of context.snapshot.connections) {
      if (row.integration !== integration.slug) continue;
      const plan = connectionPlan(context.snapshot, context.firstParty, row);
      if (!plan.ok) continue;
      const access = plan.value.access;
      if (access.kind === "first_party")
        clients.push({ id: access.client.clientId, secret: undefined });
      else if (access.kind === "oauth") {
        const item = access.client.client_secret_item_id;
        const secret =
          item === null
            ? undefined
            : yield* readSecret(context, row, item).pipe(
                Effect.map((value) => Option.some(Redacted.value(value))),
                Effect.catchTag("ItemFailed", (failed) =>
                  failed.vault === "unavailable"
                    ? Effect.fail(failed)
                    : Effect.succeed(Option.none<string>()),
                ),
                Effect.map(Option.getOrUndefined),
              );
        clients.push({ id: access.client.client_id, secret });
      }
    }
    return secrets.flatMap((secret): DroppedFixed[] => {
      if (clients.some((client) => client.id !== "" && client.id === secret.value))
        return [{ secret, reason: "oauth_client_id" }];
      if (clients.some((client) => client.secret !== undefined && client.secret === secret.value))
        return [{ secret, reason: "oauth_client_secret" }];
      return [];
    });
  });

/** The fields of fixed credentials an app leaves out. */
const droppedFields = (dropped: readonly DroppedFixed[]) =>
  new Set(dropped.map((entry) => entry.secret.field));

/** The fixed account's name in an app's requirements and its sign-in method. */
export const fixedRequirement = "fixed";

/** The plans of the integration's connections that move: those whose sign-in v2 can take. */
export const connectionPlans = (
  snapshot: ConnectionSnapshot,
  firstParty: FirstPartyClients,
  integration: Pick<IntegrationRow, "slug">,
) =>
  snapshot.connections
    .filter((row) => row.integration === integration.slug)
    .flatMap((row) => {
      const plan = connectionPlan(snapshot, firstParty, row);
      return plan.ok ? [plan.value] : [];
    });

/**
 * The v1 rows a connection's own app is decided from (decision 33): its integration's other
 * connections left out, so the app takes only its sign-in method and account.
 */
export const connectionSnapshot = <S extends Pick<V1Snapshot, "connections">>(
  snapshot: S,
  connection: Pick<ConnectionRow, "row_id" | "integration">,
): S => ({
  ...snapshot,
  connections: snapshot.connections.filter(
    (row) => row.integration !== connection.integration || row.row_id === connection.row_id,
  ),
});

/**
 * An app name the importer makes, in parts: fixed text, and text it may shorten (`{ cut }`). The
 * fixed text tells apps apart whose other text is the same, such as a connection's number.
 */
export type AppNaming = readonly (string | { readonly cut: string })[];

/** Why the importer made no app: every name it tries (`appNames`) is taken in the organization. */
export const namesTaken = "Every name for this app is taken in the organization.";

/** The names the importer tries for one app before it gives up (`namesTaken`). */
const nameAttempts = 5;

/** The longest app name (`AppName`). */
const nameLength = 120;

/** Spaces and punctuation that would dangle before a shortened text's "…". */
const dangling = /[\s\p{Ps}\p{Pd}\p{Po}]+$/u;

/** `text` shortened with "…", longest first: at each word, then at each character. */
const shortenings = (text: string) => {
  const characters = Array.from(text);
  const words = [...text.matchAll(/\s+/gu)].map((match) => text.slice(0, match.index)).reverse();
  const cuts = characters.map((_, end) => characters.slice(0, end).join("")).reverse();
  return [...words, ...cuts].map((kept) => `${kept.replace(dangling, "")}…`);
};

/**
 * The name the importer gives an app on its `attempt`: `naming`'s parts, then on a retry
 * `(v1 <attempt>)`. An app's address keeps only the start of a long name (`appSlugFits`), so a
 * name with fixed text keeps it whole and shortens the other parts, the first first, until its
 * address holds the whole name. A name that already fits stays as it is. A name of only text it
 * may shorten has nothing to tell apart, and only keeps to the length names may have.
 */
const appName = (naming: AppNaming, attempt: number) => {
  const parts = attempt === 1 ? naming : [...naming, ` (v1 ${attempt})`];
  const tellsApart = parts.some((part) => typeof part === "string");
  const fits = (texts: readonly string[]) => {
    const name = texts.join("");
    return name.length <= nameLength && (!tellsApart || appSlugFits(name));
  };
  let texts = parts.map((part) => (typeof part === "string" ? part : part.cut));
  for (const [index, part] of parts.entries()) {
    if (fits(texts)) break;
    if (typeof part === "string") continue;
    texts =
      shortenings(part.cut)
        .map((cut) => texts.with(index, cut))
        .find(fits) ?? texts.with(index, "…");
  }
  return texts.join("");
};

/**
 * The names the importer tries for an app, in order: its own, then retries numbered `(v1 N)`. Each
 * has an address of its own, so a retry never tries an address already refused.
 */
export const appNames = (naming: AppNaming) =>
  Array.from({ length: nameAttempts }, (_, index) => appName(naming, index + 1)).filter(
    (name, index, names) => names.findIndex((other) => appSlug(other) === appSlug(name)) === index,
  );

/** An integration's one app's name: its label. */
export const integrationNaming = (integration: IntegrationRow): AppNaming => [
  { cut: integrationLabel(integration) },
];

/** An artifact's app's name: its title. */
export const artifactNaming = (row: Pick<ArtifactRow, "title">): AppNaming => [
  { cut: row.title.trim() === "" ? "Artifact" : row.title },
];

/**
 * A connection's own app's name (decision 33): its integration's, then the connection's. A
 * workspace connection that shares its name with a member's says so, as its account does. App
 * names are unique in an organization, and members often gave their connections the same name, so
 * each later connection of a name is numbered, in the order v1 made them. When the name is too
 * long for its address to hold, the integration's label is shortened first, then the connection's
 * name; the marker and number stay whole (`appName`).
 */
export const connectionAppNaming = (
  snapshot: Pick<V1Snapshot, "connections">,
  integration: IntegrationRow,
  connection: ConnectionRow,
): AppNaming => {
  const nameOf = (row: ConnectionRow) =>
    row.name.trim() === "" ? "connection" : row.name.trim().slice(0, 56);
  const own = (row: ConnectionRow) =>
    accountLabel(snapshot, row) === row.name ? nameOf(row) : `${nameOf(row)}, workspace`;
  const base = own(connection);
  const index = snapshot.connections
    .filter((row) => row.integration === connection.integration && own(row) === base)
    .sort((a, b) =>
      a.created_ms !== b.created_ms
        ? a.created_ms - b.created_ms
        : a.row_id < b.row_id
          ? -1
          : a.row_id > b.row_id
            ? 1
            : 0,
    )
    .findIndex((row) => row.row_id === connection.row_id);
  const marker = base === nameOf(connection) ? "" : ", workspace";
  return [
    { cut: integrationLabel(integration) },
    " (",
    { cut: nameOf(connection) },
    `${marker}${index > 0 ? ` ${index + 1}` : ""})`,
  ];
};

/** A connection's own app's name, as its first deploy tries it (`connectionAppNaming`). */
export const connectionAppName = (
  snapshot: Pick<V1Snapshot, "connections">,
  integration: IntegrationRow,
  connection: ConnectionRow,
) => appName(connectionAppNaming(snapshot, integration, connection), 1);

/** An item context narrowed to one connection's own app (decision 33). */
const connectionContext = <C extends { readonly snapshot: ConnectionSnapshot }>(
  context: C,
  connection: ConnectionRow,
) => ({ ...context, snapshot: connectionSnapshot(context.snapshot, connection), connection });

/**
 * The app's sign-in methods, which one each importable connection uses, and the values each
 * account takes from v1's configuration. When the app takes accounts at all (another connection
 * signs in, or the integration sends fixed credentials), a connection that sent no credentials of
 * its own gets a method with only the fixed ones: "No credentials" when there are none.
 *
 * An OAuth account holds only its token, so when an OAuth connection's integration sends fixed
 * credentials its sign-in does not replace, the app holds every fixed credential in one more
 * account, linked for everyone (`fixed`, decision 22), and no method holds them. Fixed credentials
 * in `dropped` are left out.
 */
export const appMethods = (
  snapshot: ConnectionSnapshot,
  firstParty: FirstPartyClients,
  integration: IntegrationRow,
  dropped: readonly DroppedFixed[] = [],
) => {
  const methods: Record<string, GeneratedAuthMethod> = {};
  const keys = new Map<string, string>();
  const methodOf = new Map<string, string>();
  const configured = new Map<string, ReadonlyArray<readonly [string, string]>>();
  const plans = connectionPlans(snapshot, firstParty, integration);
  const decoded = integrationPlan(integration);
  const secrets = decoded.ok
    ? integrationValues(decoded.value, droppedFields(dropped)).secrets
    : [];
  const needsFixed = plans.some((plan) => {
    const access = plan.access;
    return (
      (access.kind === "oauth" || access.kind === "first_party") &&
      secrets.some((secret) => !replaces({ carrier: "header", name: access.method.header }, secret))
    );
  });
  const all = fixedPlacements(secrets, []);
  const fixed = needsFixed
    ? {
        account: { fields: all.configured.map(([field]) => field), placements: all.placements },
        configured: all.configured,
      }
    : undefined;
  // With a fixed account, the methods' accounts hold none of the fixed credentials.
  const methodSecrets = fixed === undefined ? secrets : [];
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
    const planned = plannedMethod(plan, methodSecrets);
    if (planned !== undefined) add(plan, planned);
  }
  if (Object.keys(methods).length > 0 || methodSecrets.length > 0) {
    const none = fixedPlacements(methodSecrets, []);
    const method: GeneratedAuthMethod = {
      kind: "secrets",
      label: methodSecrets.length === 0 ? "No credentials" : "Fixed credentials",
      fields: none.configured.map(([field]) => field),
      placements: none.placements,
    };
    for (const plan of plans)
      if (plan.access.kind === "none") add(plan, { method, configured: none.configured });
    // Fixed credentials without a connection still make the app take an account that holds them.
    if (Object.keys(methods).length === 0) methods.none = method;
  }
  // Org connections become accounts linked for everyone, so the app also takes those (decision 9).
  const linked = plans.some((plan) => plan.row.owner === "org" && methodOf.has(plan.row.row_id));
  return { methods, methodOf, configured, plans, linked, fixed, dropped };
};

/** What an integration's app takes, as `appMethods` plans it. */
export type AppAccounts = ReturnType<typeof appMethods>;

// ---------------------------------------------------------------------------------------------
// Tool names and approvals.

const rank = { approve: 1, default: 1.5, require_approval: 2, block: 3 } as const;
/**
 * What v1 did with a tool no policy decided, when the app's own default would not do the same: ask,
 * for an MCP tool whose row v1 stamped as needing approval. v1 asked from that stamp, made from the
 * server's `destructiveHint` when it last listed the tools; the app's default reads the live hint,
 * which a server may have dropped since, so the app asks always. OpenAPI and GraphQL defaults
 * come from the generated source (a method or a mutation), which asks wherever v1 stamped one.
 * A tool v1 did not stamp keeps the app's default.
 */
const unruled = (integration: Pick<IntegrationRow, "plugin_id">, tool: ToolRow) =>
  integration.plugin_id === "mcp" && tool.requires_approval ? "require_approval" : "default";
/**
 * Each tool's v1 policy result, combined across its connections and the v1 names it had: the most
 * restrictive, where a connection without a matching policy keeps the tool's own default, pinned
 * as `unruled` says. `aliases` maps a dropped v1 name to the name the tool keeps.
 *
 * A toolkit's own policies applied only to calls through the toolkit, and v1 ignored the
 * workspace's policies there, but v2 keeps approvals in the app for every caller. A toolkit that
 * asks before a tool it grants therefore makes the app ask. One that grants it without a rule of its
 * own left it to the tool's default, so the workspace's `approve` cannot lower it below that
 * default either. The toolkit's `approve` never lowers the workspace's result, and its `block` only
 * leaves the tool out of the toolkit's connection.
 */
export const toolActions = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
) => {
  const actions = new Map<string, PolicyAction | "default">();
  const toolkits = decodedToolkits(snapshot);
  const resolve = policyResolver(snapshot.policies, snapshot.multiMember);
  for (const tool of tools) {
    const id = `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`;
    const fallback = unruled(integration, tool);
    const own = resolve(id) ?? fallback;
    // The least the app may do for each toolkit that grants the tool: ask when the toolkit asks,
    // keep the tool's default when the toolkit left it to the default.
    const action = toolkits.reduce<PolicyAction | "default">((current, toolkit) => {
      const granted = toolkitAction(toolkit, id);
      const floor =
        granted === "require_approval" ? granted : granted === "default" ? fallback : undefined;
      return floor !== undefined && rank[floor] > rank[current] ? floor : current;
    }, own);
    const name = Object.hasOwn(aliases, tool.name) ? (aliases[tool.name] ?? tool.name) : tool.name;
    const current = actions.get(name);
    if (current === undefined || rank[action] > rank[current]) actions.set(name, action);
  }
  return actions;
};

/** The app's own rules from each tool's action: left out, `never` or `always`. */
export const approvalRules = (actions: ReadonlyMap<string, PolicyAction | "default">) => {
  const approvals: Record<string, "always" | "never"> = {};
  const omitted: string[] = [];
  for (const [name, action] of actions) {
    if (action === "block") omitted.push(name);
    else if (action === "approve") approvals[name] = "never";
    else if (action === "require_approval") approvals[name] = "always";
  }
  return { approvals, omitted };
};

/** A tool name no tool row has: only a rule's `*` in the tool's place matches it. */
const unlistedName = "\u0000";

/** Where v1 listed a tool: its connection's owner, member and name, as in v1's tool ids. */
type ToolAddress = Pick<ToolRow, "owner" | "subject" | "connection">;

const addressOf = (connection: Pick<ConnectionRow, "owner" | "subject" | "name">): ToolAddress => ({
  owner: connection.owner,
  subject: connection.subject,
  connection: connection.name,
});

/** Each of the integration's connections, and one made later in either scope. */
const integrationAddresses = (
  snapshot: Pick<V1Snapshot, "connections">,
  integration: Pick<IntegrationRow, "slug">,
): readonly ToolAddress[] => [
  ...snapshot.connections
    .filter((connection) => connection.integration === integration.slug)
    .map(addressOf),
  { owner: "org", subject: "", connection: unlistedName },
  { owner: "user", subject: "", connection: unlistedName },
];

/**
 * Rows for tools v1 had no row for, as a connection at each address would list them. v1 decided
 * such a tool by its rules once a connection listed it, so the app decides it the same way.
 */
const unlistedRows = (
  addresses: readonly ToolAddress[],
  names: Iterable<string>,
): readonly ToolRow[] =>
  [...names].flatMap((name) =>
    addresses.map((address) => ({
      ...address,
      name,
      upstream: name,
      requires_approval: false,
      listed_at: null,
    })),
  );

/**
 * The integration's tools as one connection alone lists them: a row at its address for each name
 * any of its connections listed. A tool asks by default when v1 stamped any of its rows, so
 * connections that listed it at different times do not differ by their stamps.
 */
const listedAs = (
  connection: Pick<ConnectionRow, "owner" | "subject" | "name">,
  tools: readonly ToolRow[],
): readonly ToolRow[] => {
  const byName = new Map<string, ToolRow>();
  for (const tool of tools) {
    const known = byName.get(tool.name);
    if (known === undefined || (tool.requires_approval && !known.requires_approval))
      byName.set(tool.name, tool);
  }
  return [...byName.values()].map((tool) => ({ ...tool, ...addressOf(connection) }));
};

/** The tool names the workspace's and toolkits' rules for an integration spell out in full. */
const ruleNames = (snapshot: V1Snapshot, integration: Pick<IntegrationRow, "slug">) => {
  const names = new Set<string>();
  const patterns = [
    ...snapshot.policies.map((policy) => policy.pattern),
    ...decodedToolkits(snapshot).flatMap((toolkit) =>
      toolkit.policies.map((policy) => policy.pattern),
    ),
  ];
  for (const pattern of patterns) {
    const segments = pattern.split(".");
    if (segments[0] !== integration.slug || segments.length < 4) continue;
    const name = segments.slice(3);
    if (!name.includes("*")) names.add(name.join("."));
  }
  return names;
};

/**
 * v1's result for each name `v1ToolRules` decides, and, on a server that lists tools as it runs
 * (no `exposed`), the result v1's rules give a name none of them spells out (`unnamed`). With a
 * `connection`, the results are v1's for that connection alone (decision 33).
 */
export const v1ToolDecisions = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
  exposed?: readonly string[],
  connection?: Pick<ConnectionRow, "owner" | "subject" | "name">,
) => {
  const rows = connection === undefined ? tools : listedAs(connection, tools);
  const addresses =
    connection === undefined
      ? integrationAddresses(snapshot, integration)
      : [addressOf(connection)];
  const listed = toolActions(snapshot, integration, rows, aliases);
  const unlisted = new Set(
    [...ruleNames(snapshot, integration), ...(exposed ?? [])].filter(
      (name) => !listed.has(name) && !Object.hasOwn(aliases, name),
    ),
  );
  const actions: ReadonlyMap<string, PolicyAction | "default"> = new Map([
    ...listed,
    ...toolActions(snapshot, integration, unlistedRows(addresses, unlisted)),
  ]);
  const unnamed =
    exposed === undefined
      ? toolActions(snapshot, integration, unlistedRows(addresses, [unlistedName])).get(
          unlistedName,
        )
      : undefined;
  return { actions, unnamed };
};

/**
 * The app's rules from v1's policies: each tool v1 listed (`toolActions`), each tool a rule names
 * that v1 did not list, such as one the server stopped listing, and each name in `exposed`. v1
 * decided a tool it listed later by the same rules, so none of these runs with less than v1 gave
 * it. `exposed` is every name the app can expose, when its source fixes them (OpenAPI); otherwise
 * the server lists tools as it runs, and a tool no rule names gets what v1's rules give a tool
 * they do not name (`otherwise`). With a `connection`, the rules are v1's for it alone.
 */
export const v1ToolRules = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
  exposed?: readonly string[],
  connection?: Pick<ConnectionRow, "owner" | "subject" | "name">,
): Pick<GeneratedToolRules, "approvals" | "omitted" | "otherwise"> => {
  const { actions, unnamed } = v1ToolDecisions(
    snapshot,
    integration,
    tools,
    aliases,
    exposed,
    connection,
  );
  const rules = approvalRules(actions);
  if (exposed !== undefined) return rules;
  const rule =
    unnamed === "block" ? "omitted" : unnamed === "require_approval" ? "always" : undefined;
  return rule === undefined
    ? rules
    : { ...rules, otherwise: { rule, known: [...actions.keys()].sort() } };
};

/**
 * Whether v1 decided a tool differently for two of the integration's connections (decision 33):
 * one a connection listed, a rule names or the app exposes, or, on a server that lists its tools as
 * it runs, one no rule names. Each connection's results are v1's for it alone, toolkits' included,
 * so any difference in blocking, asking, allowing or the tool's default counts.
 */
export const rulesDiffer = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  connections: ReadonlyArray<Pick<ConnectionRow, "owner" | "subject" | "name">>,
  aliases: Readonly<Record<string, string>> = {},
  exposed?: readonly string[],
) => {
  const [first, ...rest] = connections.map((connection) =>
    v1ToolDecisions(snapshot, integration, tools, aliases, exposed, connection),
  );
  return (
    first !== undefined &&
    rest.some(
      (other) =>
        other.unnamed !== first.unnamed ||
        [...first.actions].some(([name, action]) => other.actions.get(name) !== action),
    )
  );
};

/** How many tools an app's rules leave out, ask before and run without asking, as reported. */
export interface RuleCounts {
  readonly omitted: number;
  readonly always: number;
  readonly never: number;
  /** What the rules do with a tool none of them names, on a server that lists tools as it runs. */
  readonly otherwise: "omitted" | "always" | null;
}

const ruleCounts = (
  rules: Pick<GeneratedToolRules, "approvals" | "omitted" | "otherwise">,
): RuleCounts => {
  const approvals = Object.values(rules.approvals ?? {});
  return {
    omitted: rules.omitted?.length ?? 0,
    always: approvals.filter((rule) => rule === "always").length,
    never: approvals.filter((rule) => rule === "never").length,
    otherwise: rules.otherwise?.rule ?? null,
  };
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
  document: Entries,
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

/** The v1 reads source generation needs. */
export type GenerationSource = Pick<
  V1Source,
  "tools" | "openApiOperations" | "openApiBinding" | "blob" | "blobMissing" | "specification"
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

/** A v1 tool an imported app leaves out because v1 could not run it either (decision 21). */
export interface StaleTool {
  readonly tool: string;
  readonly stale: V1StaleCategory;
  readonly reason: string;
}

/**
 * An integration's generated app: its files, what the user should know, its check, the v1 tools
 * of TRACE operations it leaves out (decision 16), the v1 tools it leaves out as stale (decision
 * 21), and the fixed credentials it leaves out (decision 22). `split` says its connections' rules
 * differ, so each connection moves as its own app instead (decision 33); `rules` counts its own.
 */
export interface GeneratedApp {
  readonly files: SourceFiles;
  readonly note: string | undefined;
  readonly health: HealthOutcome;
  readonly traced: readonly string[];
  readonly stale: readonly StaleTool[];
  readonly dropped: readonly DroppedFixed[];
  readonly split: boolean;
  readonly rules: RuleCounts;
}

const healthOf = (check: GeneratedHealthCheck | undefined) =>
  check === undefined ? {} : { health: check };

/** Why an app with a fixed account has no account check. */
const fixedHealthDropped =
  "Its fixed credentials are held by a second account, which an account check cannot send.";

/** Why a tool v1 last listed before its integration was revised is stale. */
const removedTool =
  "v1 last listed it before the integration was revised, and the revised specification no longer has it, so v1 drops it when it next lists the tools.";

/**
 * The OpenAPI tools v1 last listed before the organization revised the integration, among those
 * v2 would not provide: v1 lists every such connection's tools again on its next read, from the
 * revised specification, which no longer has them. A tool any connection listed since still blocks.
 */
export const removedTools = (
  integration: Pick<IntegrationRow, "config_revised_at">,
  tools: readonly ToolRow[],
  missing: readonly string[],
) => {
  const revised = integration.config_revised_at;
  if (revised === null) return [];
  return missing.filter((name) => {
    const rows = tools.filter((tool) => tool.name === name);
    return rows.length > 0 && rows.every((tool) => (tool.listed_at ?? 0) < revised);
  });
};

const plain = (values: readonly string[]) => (values.length === 1 ? "it is" : "they are");

/** What the user should know about the tools and fixed credentials an app leaves out. */
const leftOutNote = (app: Pick<GeneratedApp, "traced" | "stale" | "dropped">) => {
  const notes: string[] = [];
  if (app.traced.length > 0)
    notes.push(
      `v2 sends no TRACE requests, so ${app.traced.length === 1 ? "its TRACE tool is" : "its TRACE tools are"} left out: ${app.traced.join(", ")}.`,
    );
  if (app.stale.length > 0)
    notes.push(
      `v1 could not run ${app.stale.length === 1 ? "one of its tools" : `${app.stale.length} of its tools`} either, so ${plain(app.stale.map((tool) => tool.tool))} left out: ${app.stale.map((tool) => tool.tool).join(", ")}.`,
    );
  if (app.dropped.length > 0)
    notes.push(
      `Its fixed ${app.dropped.map((entry) => `${entry.secret.carrier} ${entry.secret.name}`).join(", ")} repeated its OAuth client's own credentials, so ${plain(app.dropped.map((entry) => entry.secret.name))} not sent.`,
    );
  return notes.length === 0 ? undefined : notes.join(" ");
};

/**
 * The document v1 stored for an OpenAPI integration, read as v1 read it: a Microsoft Graph preset's
 * entry by entry from its text, as v1 compiled it, and any other whole.
 */
const storedDocument = (
  source: GenerationSource,
  decoded: Extract<ImportableIntegration, { readonly plugin: "openapi" }>,
  bytes: Uint8Array,
) =>
  Effect.gen(function* () {
    if (decoded.config.specFormat === microsoftGraphFormat) {
      const read = blockYamlDocument(bytes);
      if (!read.ok) return yield* fail(read.reason);
      return read;
    }
    const read = parseSpec(bytes);
    if (read.ok === false) return yield* failStale("unreadable_spec", read.reason);
    // v1 stored some specifications as their URL and fetched the document once; so does this.
    // v1 kept what it fetched, so a document that cannot be fetched or read now still blocks.
    const parsed =
      read.ok === "url"
        ? parseSpec(
            yield* source
              .specification(read.url)
              .pipe(Effect.catchTag("SpecificationUnavailable", (error) => fail(error.reason))),
          )
        : read;
    if (parsed.ok === "url")
      return yield* fail("v1's stored specification is a URL whose document is another URL.");
    if (!parsed.ok) return yield* fail(parsed.reason);
    return {
      document: parsedDocument(parsed.document),
      unread: (): string | undefined => undefined,
    };
  });

/**
 * The integration's stored document cut to v1's operations, with v1's operation rows and tool
 * listing. The stored bytes and the document read from them end with this, before the app is
 * generated from the cut.
 */
const importedSpecification = (
  context: { readonly snapshot: V1Snapshot; readonly source: GenerationSource },
  integration: IntegrationRow,
  decoded: Extract<ImportableIntegration, { readonly plugin: "openapi" }>,
) =>
  Effect.gen(function* () {
    const { tenant, subjects } = context.snapshot;
    const stored = yield* context.source.blob(tenant, "openapi", `spec/${decoded.specHash}`);
    if (Option.isNone(stored)) return yield* fail(context.source.blobMissing);
    const { document, unread } = yield* storedDocument(context.source, decoded, stored.value);
    const operations = yield* context.source.openApiOperations(tenant, integration.slug);
    const tools = yield* context.source.tools(tenant, subjects, integration.slug);
    const compiled = importedDocument(
      document,
      operations,
      compiledTools(document, operations, tools),
    );
    // An entry the cut read could not be parsed: v1 could not read it either.
    const reason = unread();
    if (reason !== undefined) return yield* failStale("unreadable_spec", reason);
    return { compiled, operations, tools };
  });

/** An integration's app source, generated from v1's rows without writing anything. */
export const generate = (
  context: {
    readonly snapshot: V1Snapshot;
    readonly source: GenerationSource;
    /**
     * False to generate the app as the importer did before it decided tools v1 did not list
     * (`v1ToolRules`), for the repair of organizations moved before then.
     */
    readonly unlistedRules?: boolean;
    /**
     * The connection whose own app this is (decision 33), with the snapshot narrowed to it
     * (`connectionSnapshot`): its rules are v1's for that connection alone.
     */
    readonly connection?: ConnectionRow;
  },
  integration: IntegrationRow,
  decoded: ImportableIntegration,
  planned: Pick<AppAccounts, "methods" | "linked" | "fixed" | "dropped" | "plans">,
) =>
  Effect.gen(function* () {
    const { methods, linked: appLinkedAccounts, dropped } = planned;
    const fixedAccount = planned.fixed?.account;
    const name = integrationLabel(integration);
    const { tenant, subjects } = context.snapshot;
    const accounts = Object.keys(methods).length > 0;
    // Credentials in v1's configuration are account fields; only the rest is written to source.
    const { headers, queryParams } = integrationValues(decoded);
    const accountOptions = {
      appLinkedAccounts,
      ...(fixedAccount === undefined ? {} : { fixedAccount }),
    };
    const left = { traced: [], stale: [], dropped } as const;
    // The app's rules, and for the whole integration whether its connections' rules differ.
    const toolRules = (
      tools: readonly ToolRow[],
      aliases?: Readonly<Record<string, string>>,
      exposed?: readonly string[],
    ) => {
      const rules =
        context.unlistedRules === false
          ? approvalRules(toolActions(context.snapshot, integration, tools, aliases))
          : v1ToolRules(context.snapshot, integration, tools, aliases, exposed, context.connection);
      const split =
        context.connection === undefined &&
        context.unlistedRules !== false &&
        rulesDiffer(
          context.snapshot,
          integration,
          tools,
          planned.plans.map((plan) => plan.row),
          aliases,
          exposed,
        );
      return { rules, split, counts: ruleCounts(rules) };
    };
    switch (decoded.plugin) {
      case "mcp": {
        const tools = yield* context.source.tools(tenant, subjects, integration.slug);
        const { rename, overrides, aliases, missing } = mcpNaming(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const decided = toolRules(tools, aliases);
        const rules: GeneratedToolRules = {
          ...(rename ? { names: { kind: "lower_snake", overrides } } : {}),
          ...decided.rules,
        };
        const aliased = Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1));
        const generated = yield* generateMcpSource(
          name,
          decoded.config.endpoint,
          { kind: "methods", methods },
          { headers, queryParams, tools: rules, ...accountOptions },
        );
        const notes = [
          ...(aliased.length === 0
            ? []
            : [
                `v1 listed ${aliased.length === 1 ? "a tool" : "tools"} under two names; ${aliased
                  .map(([alias, kept]) => `${alias} is now ${kept}`)
                  .join(", ")}.`,
              ]),
          ...(leftOutNote(left) === undefined ? [] : [leftOutNote(left)]),
        ];
        return {
          files: generated.files,
          note: notes.length === 0 ? undefined : notes.join(" "),
          // v1's MCP check only listed tools, whatever it declared, as mcpHealth does.
          health: !accounts
            ? { kind: "none" as const }
            : fixedAccount !== undefined
              ? { kind: "dropped" as const, reason: fixedHealthDropped }
              : { kind: "mcp" as const, declared: integration.health_check !== null },
          ...left,
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
      case "graphql": {
        const tools = yield* context.source.tools(tenant, subjects, integration.slug);
        const missing = graphqlMissing(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const decided = toolRules(tools);
        const check: GeneratedHealthCheck | undefined =
          accounts && decoded.healthCheck && fixedAccount === undefined
            ? { kind: "graphql", query: v1IntrospectionQuery }
            : undefined;
        const generated = yield* graphqlAppSource({
          name,
          url: decoded.config.endpoint,
          methods,
          ...accountOptions,
          headers,
          queryParams,
          tools: {
            names: { kind: "graphql_path" },
            ...decided.rules,
          },
          ...healthOf(check),
        });
        return {
          files: generated.files,
          note: leftOutNote(left),
          health:
            check !== undefined
              ? { kind: "graphql" as const }
              : accounts && decoded.healthCheck && fixedAccount !== undefined
                ? { kind: "dropped" as const, reason: fixedHealthDropped }
                : { kind: "none" as const },
          ...left,
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
      case "openapi": {
        const { compiled, operations, tools } = yield* importedSpecification(
          context,
          integration,
          decoded,
        );
        // v1 sent each operation to its own server unless the integration set a base URL, with the
        // account's credentials on every one, and the app does the same. An operation v1 never
        // reached, on a server that is not http(s) or uses an undefined variable, is left out.
        const servers = operationBaseUrls(decoded.config, compiled.document);
        if (!servers.ok) return yield* refused(servers);
        const reachable = withoutOperations(compiled, servers.unreachable);
        const prepared = { ...compiled, document: reachable.document, named: reachable.named };
        const unreachable = reachable.removed.flatMap(({ key, tool }): StaleTool[] => {
          const operation = servers.unreachable.find(
            (candidate) => `${candidate.method} ${candidate.path}` === key,
          );
          return operation === undefined
            ? []
            : [{ tool, stale: operation.stale, reason: operation.reason }];
        });
        // The account's credentials go to every origin its operations call, as in v1; the
        // provider's hosts keep them to exactly those.
        const origins = credentialOrigins(servers.urls);
        // v1 also sent the credentials over plain HTTP when a server named it; an app that sends
        // them to several hosts does so only over HTTPS.
        const insecure = accounts && origins.length > 1 ? plainHttpHosts(origins) : [];
        if (insecure.length > 0)
          return yield* fail(
            `Its operations call ${insecure.join(", ")} over plain HTTP, and an imported app sends an account's credentials to more than one host only over HTTPS.`,
          );
        // The name liveOpenapiRouter gives each operation, as it reads the document, mapped to v1's.
        const declared = yield* Effect.tryPromise({
          try: () => openapiOperationNames(prepared.document),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof OpenapiCompileError ? fail(error.reason) : Effect.die(error),
          ),
        );
        const names: Record<string, string> = {};
        for (const operation of declared) {
          const v1 = prepared.named.get(`${operation.method.toLowerCase()} ${operation.path}`);
          if (v1 !== undefined) names[operation.name] = v1;
        }
        const exposed = new Set(Object.values(names));
        // Every tool v1 bound or last listed, except those of the TRACE operations it drops and
        // of the operations v1 never reached.
        const leftOut = new Set([...prepared.traced, ...unreachable.map((tool) => tool.tool)]);
        const missing = [
          ...new Set([...operations.map((operation) => operation.tool), ...toolNames(tools)]),
        ].filter((tool) => !exposed.has(tool) && !leftOut.has(tool));
        const removed = new Set(removedTools(integration, tools, missing));
        const blocking = missing.filter((tool) => !removed.has(tool));
        if (blocking.length > 0) return yield* fail(missingNames(blocking));
        const stale: readonly StaleTool[] = [
          ...unreachable,
          ...[...removed]
            .sort()
            .map((tool) => ({ tool, stale: "removed_tool" as const, reason: removedTool })),
        ];
        const staleNames = new Set(stale.map((tool) => tool.tool));
        const spec = decoded.healthCheck;
        const checked =
          !accounts || spec === undefined
            ? undefined
            : fixedAccount !== undefined
              ? ({ ok: false, reason: fixedHealthDropped } as const)
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
        const decided = toolRules(
          tools.filter((tool) => !staleNames.has(tool.name)),
          {},
          [...exposed].filter((name) => !staleNames.has(name)),
        );
        const generated = yield* openapiAppSource({
          name,
          document: prepared.document,
          baseUrl: decoded.config.baseUrl,
          allowedOrigins: origins,
          methods,
          ...accountOptions,
          headers,
          queryParams,
          tools: { names: { kind: "map", names }, ...decided.rules },
          ...healthOf(checked?.ok === true ? checked.check : undefined),
        });
        const outcome = { traced: prepared.traced, stale, dropped };
        return {
          files: generated.files,
          note: leftOutNote(outcome),
          ...outcome,
          health:
            checked === undefined
              ? { kind: "none" as const }
              : checked.ok
                ? {
                    kind: "request" as const,
                    identity:
                      checked.check.kind === "request" && checked.check.identity !== undefined,
                  }
                : { kind: "dropped" as const, reason: checked.reason },
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
    }
  }).pipe(Effect.catchTag("TemplateError", (error) => fail(error.reason)));

/**
 * Deploy under the app's name, then a numbered one when another app in the organization has its
 * name or address (`appNames`).
 */
const deployNamed = (context: ItemContext, naming: AppNaming, files: SourceFiles) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    for (const candidate of appNames(naming)) {
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
    return yield* fail(namesTaken);
  });

/**
 * Build failures name their stage and the failure in the generated source, which holds no
 * credentials. A build that ran out of memory, or whose compiler did not answer, says nothing
 * about the source: those fail the step, which retries them.
 */
const buildFailures = {
  VersionBuildFailed: (error: { readonly message: string }) =>
    fail(`The generated app did not build. ${error.message}`),
};

/** Why an integration whose connections' rules differ is still one app. */
export const splitKept =
  "Its connections have different v1 rules, but an earlier run imported it as one app, which keeps the strictest rule of each tool.";

/**
 * Deploy the integration's app for the organization: shared with everyone, created by the owner.
 * An earlier run's app gets a new version. An integration whose connections' rules differ is not
 * deployed (`split`): each connection becomes its own app (`importConnectionApp`), unless an
 * earlier run imported it as one app, which stays one.
 */
export const importIntegration = (
  context: ItemContext,
  integration: IntegrationRow,
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(integration);
    if (!plan.ok) return yield* refused(plan);
    const planned = appMethods(
      context.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(context, integration),
    );
    const generated = yield* generate(context, integration, plan.value, planned);
    if (generated.split && existing === undefined) return { kind: "split" as const };
    const owner = organizationOwner(context.target.id);
    const app =
      existing === undefined
        ? yield* deployNamed(context, integrationNaming(integration), generated.files)
        : (yield* context.executor.apps.deploy({
            owner,
            app: existing,
            files: yield* scopeGeneratedPackage(
              generated.files,
              context.target.slug,
              integrationLabel(integration),
            ).pipe(Effect.catch(() => fail("The app package could not be named."))),
          })).app;
    const note = generated.split
      ? [generated.note, splitKept].filter((text) => text !== undefined).join(" ")
      : generated.note;
    return {
      kind: "one" as const,
      result: imported("app", app.id, note),
      app: app.id,
      traced: generated.traced,
      stale: generated.stale,
      dropped: generated.dropped,
    };
  }).pipe(
    Effect.catchTags({
      ...buildFailures,
      AppNotFound: () => fail("Its imported app was removed."),
    }),
    sharedAppCreation,
    Effect.provideService(CurrentUserId, context.owner),
  );

/**
 * Deploy one connection's own app (decision 33): its integration's app as that connection alone
 * would have it, named after both. An org connection's app is shared with everyone and created by
 * the owner; a member's is theirs alone, as their connection was in v1. An earlier run's app gets a
 * new version.
 */
export const importConnectionApp = (
  context: ItemContext,
  integration: IntegrationRow,
  connection: ConnectionRow,
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const creator = actorOf(context, connection);
    if (creator === undefined) return yield* fail("Its member is not imported.");
    const created = Effect.gen(function* () {
      const plan = integrationPlan(integration);
      if (!plan.ok) return yield* refused(plan);
      const own = connectionContext(context, connection);
      const planned = appMethods(
        own.snapshot,
        context.firstParty,
        integration,
        yield* redundantFixed(own, integration),
      );
      const generated = yield* generate(own, integration, plan.value, planned);
      const naming = connectionAppNaming(context.snapshot, integration, connection);
      const name = connectionAppName(context.snapshot, integration, connection);
      const app =
        existing === undefined
          ? yield* deployNamed(context, naming, generated.files)
          : (yield* context.executor.apps.deploy({
              owner: organizationOwner(context.target.id),
              app: existing,
              files: yield* scopeGeneratedPackage(generated.files, context.target.slug, name).pipe(
                Effect.catch(() => fail("The app package could not be named.")),
              ),
            })).app;
      return {
        result: imported("app", app.id, generated.note),
        app: app.id,
        // The name it has: a retry's when an earlier app took the first (`appNames`).
        name: app.name,
        traced: generated.traced,
        stale: generated.stale,
        dropped: generated.dropped,
        rules: generated.rules,
      };
    }).pipe(
      Effect.catchTags({
        ...buildFailures,
        AppNotFound: () => fail("Its imported app was removed."),
      }),
    );
    return yield* (connection.owner === "org" ? sharedAppCreation(created) : created).pipe(
      Effect.provideService(CurrentUserId, creator),
    );
  });

/** The app's fixed account's field names and values, from v1's configuration (decision 22). */
const fixedAccount = (planned: AppAccounts) =>
  planned.fixed === undefined
    ? fail("Its imported app takes fixed credentials its integration no longer has.")
    : Effect.succeed({
        names: planned.fixed.account.fields,
        values: Redacted.make(Object.fromEntries(planned.fixed.configured)),
      });

/** The map key of a fixed account: its integration's, or its connection's own app's. */
const fixedKey = (integration: IntegrationRow, connection: ConnectionRow | undefined) =>
  connection === undefined ? integration.row_id : `${integration.row_id}:${connection.row_id}`;

/**
 * Save the account that holds the integration's fixed credentials, from v1's configuration, and
 * link it to the app's `fixed` requirement for everyone (decision 22), when the app declares one.
 * The owner owns it. Its map row keeps it for a retry, while the app's
 * provider for it is unchanged; linking again changes nothing. With a `connection`, the app is that
 * connection's own (decision 33), which holds its own fixed account.
 */
export const importFixedAccount = (
  context: ItemContext,
  integration: IntegrationRow,
  app: AppId,
  connection?: ConnectionRow,
) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    const deployed = yield* context.executor.apps.get({ owner, app });
    const requirement = deployed.requirements.accounts[fixedRequirement];
    if (requirement === undefined) return undefined;
    const scoped = connection === undefined ? context : connectionContext(context, connection);
    const planned = appMethods(
      scoped.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(scoped, integration),
    );
    const fixed = yield* fixedAccount(planned);
    const hash = yield* sourceHash({ provider: requirement.provider, fields: fixed.names });
    const key = fixedKey(integration, connection);
    const existing = yield* context.store.find("fixed_credentials", key);
    const record = (result: MapResult) =>
      context.store.record({
        organization: context.snapshot.tenant,
        kind: "fixed_credentials",
        id: key,
        result,
        hash,
      });
    const label =
      connection === undefined
        ? integrationLabel(integration)
        : connectionAppName(context.snapshot, integration, connection);
    const account =
      existing?.status === "imported" && existing.v2_id !== null && existing.source_hash === hash
        ? AccountId.make(existing.v2_id)
        : yield* context.executor[StorageHost].transaction(
            Effect.gen(function* () {
              const added = yield* context.executor.managedAccounts
                .add({
                  owner,
                  provider: requirement.provider,
                  method: fixedRequirement,
                  label: `${label} fixed credentials`,
                  fields: fixed.values,
                })
                .pipe(personalAccountCreation(context.owner));
              yield* record(imported("account", added.id));
              return added.id;
            }),
          );
    yield* linkAppAccount(context.executor, context.sql, {
      app,
      requirement: fixedRequirement,
      account,
      linkedBy: context.owner,
    });
    return account;
  }).pipe(
    Effect.catchTag("AppNotFound", () => fail("Its imported app was removed.")),
    Effect.provideService(CurrentUserId, context.owner),
  );

/**
 * Generate and compile the integration's app as an import would, and read the requirements it
 * declares, writing nothing: no app, version or source is saved, and the build is neither kept
 * nor cached (`apps.build`). The dry run's check that every app builds. `split` says the import
 * makes an app per connection instead, which the dry run checks with a `connection` each.
 */
export const checkIntegration = (
  context: Pick<ItemContext, "executor" | "snapshot" | "source" | "firstParty"> & {
    /** Names the build in its errors; nothing is saved under it. */
    readonly owner: OwnerId;
    /** The slug the organization would get, which scopes the app's package name. */
    readonly slug: string;
  },
  integration: IntegrationRow,
  connection?: ConnectionRow,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(integration);
    if (!plan.ok) return yield* refused(plan);
    const scoped = connection === undefined ? context : connectionContext(context, connection);
    const planned = appMethods(
      scoped.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(scoped, integration),
    );
    const generated = yield* generate(scoped, integration, plan.value, planned);
    const name =
      connection === undefined
        ? integrationLabel(integration)
        : connectionAppName(context.snapshot, integration, connection);
    const built = yield* context.executor.apps.build({
      owner: context.owner,
      name,
      files: yield* scopeGeneratedPackage(generated.files, context.slug, name).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      ),
    });
    return {
      name,
      note: generated.note,
      traced: generated.traced,
      stale: generated.stale,
      dropped: generated.dropped,
      health: generated.health,
      split: generated.split,
      rules: generated.rules,
      accounts: built.requirements.accounts,
    };
  }).pipe(Effect.catchTags(buildFailures));

/**
 * Check the account `importFixedAccount` would save for the app, against the requirements its
 * build declares, and save nothing.
 */
export const checkFixedAccount = (
  context: Pick<ItemContext, "executor" | "snapshot" | "source" | "firstParty">,
  integration: IntegrationRow,
  accounts: AppAccountRequirements,
  connection?: ConnectionRow,
) =>
  Effect.gen(function* () {
    const requirement = accounts[fixedRequirement];
    if (requirement === undefined) return;
    const scoped = connection === undefined ? context : connectionContext(context, connection);
    const planned = appMethods(
      scoped.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(scoped, integration),
    );
    yield* context.executor[OAuthGrantImport].checkAccountFields({
      provider: requirement.provider,
      definition: requirement.definition,
      method: fixedRequirement,
      fields: (yield* fixedAccount(planned)).values,
    });
  });

// ---------------------------------------------------------------------------------------------
// Connections.

/**
 * Why a copied sign-in could not be set up, in the words of what to do next. An outage clears up
 * by itself, so support can retry it, unless v1's last verdict on the connection was already a
 * failure (decision 36): then it is not expected to, and it needs a new sign-in like the rest.
 */
const oauthSetupRefusal = (reason: OAuthSetupFailed["reason"], row: ConnectionRow) =>
  reason === "service_unavailable" && failingInV1(row)
    ? new ItemFailed({
        reason:
          "The service did not respond while its sign-in was set up, and it was failing in v1 too. Reconnect it in v2.",
      })
    : reason === "service_unavailable" || reason === "rate_limited"
      ? new ItemFailed({
          reason:
            "The service did not respond while its sign-in was set up. Contact support if you need it.",
          outage: true,
        })
      : new ItemFailed({
          reason:
            reason === "discovery_missing" ||
            reason === "discovery_invalid" ||
            reason === "discovery_blocked"
              ? "The service no longer says how to sign in to it. Reconnect it in v2."
              : "Its sign-in could not be carried over to v2. Reconnect it in v2.",
        });

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

/**
 * A connection's or client's secret from v1's Vault, read as v1 read it: an org item in the
 * organization's partition, a user-scoped item in the partition of the member who saved it (see
 * {@link secretSubjects}). One that no partition holds is stale: v1 cannot send it either.
 */
export const readSecret = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<V1Snapshot, "tenant" | "subjects">;
  },
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
) => readSecretOf(context, row, itemId, false).pipe(Effect.map(({ value }) => value));

/**
 * A connection's secret as `readSecret` reads it, and, for an org connection whose user-scoped item
 * several members hold, how many hold it and how many distinct values they hold (decision 23).
 * The first member's value is the one that moves; the others are only compared, in memory.
 */
export const readSecretCompared = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<V1Snapshot, "tenant" | "subjects">;
  },
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
) => readSecretOf(context, row, itemId, true);

const readSecretOf = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<V1Snapshot, "tenant" | "subjects">;
  },
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
  compare: boolean,
) =>
  Effect.gen(function* () {
    // The first subject whose partition holds the item, as v1 found it for that caller.
    let first: string | undefined;
    const values = new Set<string>();
    let holders = 0;
    for (const subject of secretSubjects(context.snapshot, row, itemId)) {
      const value = yield* context.source
        .secret({ tenant: context.snapshot.tenant, subject, itemId })
        .pipe(
          Effect.catchTag("V1VaultUnavailable", () =>
            Effect.fail(
              new ItemFailed({
                reason: "v1's Vault did not answer while its saved credential was read.",
                vault: "unavailable",
              }),
            ),
          ),
        );
      if (value === undefined || value === "") continue;
      first ??= value;
      holders += 1;
      values.add(value);
      if (!compare) break;
    }
    if (first === undefined)
      return yield* new ItemFailed({
        reason: "Its saved credential could not be found in v1. Reconnect it in v2.",
        vault: "missing",
        stale: "missing_credential",
      });
    return { value: Redacted.make(first), holders, values: values.size };
  });

/**
 * The subjects whose Vault partition may hold a connection's item. v1 reads an item with the
 * calling member's binding, and a user-scoped item (`connection:user:…`) lives under the subject
 * that saved it. A member's own connection is read as them. An org connection has no subject
 * (`''`), and one that holds a user-scoped item, saved before it was shared, resolved in v1 for
 * the member who saved it, so each imported member is tried in turn. Org-scoped and legacy items
 * do not depend on the subject.
 */
const secretSubjects = (
  snapshot: Pick<V1Snapshot, "subjects">,
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
): readonly string[] =>
  row.owner === "org" && itemOwner(itemId) === "user" ? snapshot.subjects : [row.subject];

/** The account's name; an org connection yields its name to a personal one. */
export const accountLabel = (snapshot: Pick<V1Snapshot, "connections">, row: ConnectionRow) =>
  row.owner === "org" &&
  snapshot.connections.some(
    (other) =>
      other.owner === "user" && other.integration === row.integration && other.name === row.name,
  )
    ? `${row.name} (workspace)`
    : row.name;

/** The app requirement a connection's account is linked to: everyone's for an org connection. */
export const connectionRequirement = (row: Pick<ConnectionRow, "owner">) =>
  row.owner === "org" ? "workspace" : "service";

/** The accounts an integration's app takes, by requirement: a deployed app's or a build's. */
export type AppAccountRequirements = DeployedApp["requirements"]["accounts"];

/**
 * The account a connection's import saves, decided from v1's rows and secrets and the app's
 * requirements, writing nothing: the requirement it fills and the grant or fields it holds, or
 * why it cannot be saved. The import saves it (`importAccount`) and the dry run checks it
 * (`checkAccount`), so a dry run refuses every account an import would, with the same reason.
 */
type AccountWrite =
  | {
      readonly kind: "grant";
      readonly requirement: AccountRequirement;
      readonly input: ImportOAuthGrant;
      /** The operator's client a first-party grant moves to, which its refusal names. */
      readonly firstParty?: {
        readonly name: string;
        readonly client: { readonly placement: { readonly hosts: readonly string[] } };
        readonly hosts: readonly string[];
      };
    }
  | {
      readonly kind: "fields";
      readonly requirement: AccountRequirement;
      readonly input: {
        readonly owner: OwnerId;
        readonly provider: AccountRequirement["provider"];
        readonly method: string;
        readonly label: string;
        readonly fields: Redacted.Redacted<Record<string, string>>;
      };
    };

/** Reads one of a connection's secrets from v1's Vault, as `readSecret` does. */
export type SecretReader = (itemId: string) => ReturnType<typeof readSecret>;

/**
 * Whether a connection's account goes to its own app (decision 33), whose sign-in methods are its
 * alone, or to its integration's one app.
 */
export type AppScope = "own" | "integration";

/** The sign-in methods of the app a connection's account goes to. */
const plannedFor = (
  context: Pick<ItemContext, "source" | "firstParty"> & { readonly snapshot: ConnectionSnapshot },
  plan: Pick<ConnectionPlan, "row" | "integration">,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const scoped = scope === "own" ? connectionContext(context, plan.row) : context;
    return appMethods(
      scoped.snapshot,
      context.firstParty,
      plan.integration,
      yield* redundantFixed(scoped, plan.integration),
    );
  });

const accountWrite = (
  context: Pick<ItemContext, "source" | "firstParty"> & { readonly snapshot: ConnectionSnapshot },
  plan: ConnectionPlan,
  accounts: AppAccountRequirements,
  owner: OwnerId,
  secret: SecretReader,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const requirement = accounts[connectionRequirement(plan.row)];
    if (requirement === undefined) return yield* fail("Its imported app takes no account.");
    const planned = yield* plannedFor(context, plan, scope);
    const method = planned.methodOf.get(plan.row.row_id);
    if (method === undefined) return yield* fail("Its sign-in method is not in the imported app.");
    const base = {
      owner,
      provider: requirement.provider,
      method,
      label: accountLabel(context.snapshot, plan.row),
    };
    const expiresAt = plan.row.expires_at === null ? {} : { expiresAt: plan.row.expires_at };
    const access = plan.access;
    if (access.kind === "first_party") {
      const accessToken = yield* secret(access.accessItem);
      const refreshToken =
        plan.row.refresh_item_id === null ? undefined : yield* secret(plan.row.refresh_item_id);
      const hosts = requirement.definition.hosts ?? [];
      return {
        kind: "grant",
        requirement,
        input: {
          ...base,
          redirectUri: v1OAuthCallback,
          firstParty: access.client.id,
          hosts,
          accessToken,
          refreshToken,
          ...expiresAt,
          renewal: access.renewal,
        },
        firstParty: { name: firstPartyName(access.client.id), client: access.client, hosts },
      } satisfies AccountWrite as AccountWrite;
    }
    if (access.kind !== "oauth") {
      // Values from v1's configuration first, then the connection's own from v1's Vault.
      const fields: Record<string, string> = Object.fromEntries(
        planned.configured.get(plan.row.row_id) ?? [],
      );
      if (access.kind === "secrets")
        for (const [variable, item] of access.items)
          fields[variable] = Redacted.value(yield* secret(item));
      return {
        kind: "fields",
        requirement,
        input: { ...base, fields: Redacted.make(fields) },
      } satisfies AccountWrite as AccountWrite;
    }
    const { client, grant } = access;
    const clientSecret =
      client.client_secret_item_id === null
        ? undefined
        : yield* secret(client.client_secret_item_id);
    const registration = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
      client_id: client.client_id,
      token_endpoint_auth_method:
        clientSecret === undefined
          ? "none"
          : (tokenEndpointAuthMethod(client.token_endpoint_auth_method) ?? "client_secret_post"),
      ...(clientSecret === undefined ? {} : { client_secret: Redacted.value(clientSecret) }),
    }).pipe(Effect.catch(() => fail("Its OAuth client could not be read.")));
    const accessToken = yield* secret(access.accessItem);
    const refreshToken =
      grant === "authorization_code" && plan.row.refresh_item_id !== null
        ? yield* secret(plan.row.refresh_item_id)
        : undefined;
    return {
      kind: "grant",
      requirement,
      input: {
        ...base,
        ...(grant === "authorization_code"
          ? { redirectUri: client.origin_redirect_uri ?? v1OAuthCallback }
          : {}),
        client: Redacted.make(registration),
        accessToken,
        refreshToken,
        ...expiresAt,
        renewal: access.renewal,
      },
    } satisfies AccountWrite as AccountWrite;
  });

/** Why v2 refused to save a connection's grant, as the user reads it, for an import and a check. */
const grantRefusals = (write: Extract<AccountWrite, { kind: "grant" }>, row: ConnectionRow) =>
  Effect.catchTags({
    OAuthSetupFailed: (error: OAuthSetupFailed) =>
      Effect.fail(oauthSetupRefusal(error.reason, row)),
    AuthMethodInvalid: () => fail("Its sign-in method is not in the imported app."),
    OAuthGrantNotImportable: (error: OAuthGrantNotImportable) =>
      write.firstParty === undefined
        ? fail("Its sign-in could not be carried over to v2. Reconnect it in v2.")
        : fail(
            firstPartyRefusal(
              write.firstParty.name,
              write.firstParty.client,
              write.firstParty.hosts,
              error,
            ),
          ),
  });

/** Whether a connection's app is public: it takes no account, so the connection needs none. */
export const needsNoAccount = (plan: ConnectionPlan, accounts: AppAccountRequirements) =>
  plan.access.kind === "none" && accounts.service === undefined && accounts.workspace === undefined;

/**
 * Save the connection's account: an org connection's is the owner's, linked for everyone, and a
 * member's is their own. The map row commits with it.
 */
export const importAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const actor = actorOf(context, plan.row);
    if (actor === undefined) return yield* fail("Its member is not imported.");
    return yield* saveAccount(context, plan, app, record, actor, scope).pipe(
      Effect.provideService(CurrentUserId, actor),
    );
  });

const saveAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
  actor: string,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    // Every account is personal: the owner's for an org connection (`actorOf`), else the member's.
    const creation = personalAccountCreation(actor);
    const write = yield* accountWrite(
      context,
      plan,
      app.requirements.accounts,
      organizationOwner(context.target.id),
      (itemId) => readSecret(context, plan.row, itemId),
      scope,
    );
    if (write.kind === "fields")
      return yield* context.executor[StorageHost].transaction(
        Effect.gen(function* () {
          const account = yield* context.executor.managedAccounts.add(write.input).pipe(creation);
          yield* record(imported("account", account.id));
          return account.id;
        }),
      );
    const account = yield* context.executor[OAuthGrantImport]
      .importOAuthGrant(write.input)
      .pipe(creation, grantRefusals(write, plan.row));
    // Discovery ran outside a transaction; the account is recorded as soon as it exists.
    yield* record(imported("account", account.id));
    return account.id;
  });

/**
 * The account of a connection an earlier run imported, given v1's tokens as they are now. An
 * organization copied before it moved ran in both products, and both renewed the connection's
 * grant; a service that rotates refresh tokens keeps only the last renewal's. Once the
 * organization moves, v1 no longer renews, so its tokens are final, and the account takes them
 * when its own grant needs reconnecting or v1 renewed after it did (`refreshImportedGrant`). A
 * connection without an authorization-code grant, or whose tokens v1's Vault no longer holds, is
 * left as it is.
 */
export const refreshCopiedGrant = (context: ItemContext, row: ConnectionRow, account: AccountId) =>
  Effect.gen(function* () {
    const plan = connectionPlan(context.snapshot, context.firstParty, row);
    if (!plan.ok) return "kept" as const;
    const { access } = plan.value;
    const accessItem =
      access.kind === "first_party" ||
      (access.kind === "oauth" && access.grant === "authorization_code")
        ? access.accessItem
        : undefined;
    if (accessItem === undefined || row.refresh_item_id === null) return "kept" as const;
    const tokens = {
      accessToken: yield* readSecret(context, row, accessItem),
      refreshToken: yield* readSecret(context, row, row.refresh_item_id),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };
    return yield* context.executor[OAuthGrantImport].refreshImportedGrant(account, tokens);
  }).pipe(Effect.catchTag("ItemFailed", () => Effect.succeed("kept" as const)));

/**
 * Keep the account of a connection an earlier run imported fitting its app once the app is
 * generated again. The app declares one provider for every sign-in method its connections use, so
 * a connection v1 gained or lost since, or a new name, makes it another provider, which the saved
 * account does not fit. The account moves to it, under the method its connection signs in with
 * now, when that method is the one it was saved for (`moveImportedAccount`); otherwise it is left
 * as it is. Returns whether it moved.
 */
export const followAppProvider = (
  context: ItemContext,
  row: ConnectionRow,
  accounts: AppAccountRequirements,
  account: AccountId,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const requirement = accounts[connectionRequirement(row)];
    const plan = connectionPlan(context.snapshot, context.firstParty, row);
    if (requirement === undefined || !plan.ok) return false;
    const planned = yield* plannedFor(context, plan.value, scope);
    const method = planned.methodOf.get(row.row_id);
    if (method === undefined) return false;
    return yield* context.executor[OAuthGrantImport].moveImportedAccount({
      account,
      provider: requirement.provider,
      method,
    });
  }).pipe(Effect.catchTag("ItemFailed", () => Effect.succeed(false)));

/**
 * How an earlier run imported an integration: as one app, or as an app per connection (decision
 * 32), by the connection's row id. An integration imported as one app stays one, and one imported
 * per connection stays so, on every later run.
 */
export const importedApps = (
  store: Pick<ImportStore, "find">,
  snapshot: Pick<V1Snapshot, "connections">,
  integration: Pick<IntegrationRow, "row_id" | "slug">,
) =>
  Effect.gen(function* () {
    const found = yield* store.find("integration", integration.row_id);
    if (found?.status === "imported" && found.v2_id !== null)
      return { kind: "one", app: AppId.make(found.v2_id) } as const;
    const apps = new Map<string, AppId>();
    for (const connection of snapshot.connections) {
      if (connection.integration !== integration.slug) continue;
      const own = yield* store.find("connection_app", connection.row_id);
      if (own?.status === "imported" && own.v2_id !== null)
        apps.set(connection.row_id, AppId.make(own.v2_id));
    }
    return apps.size > 0 ? ({ kind: "split", apps } as const) : undefined;
  });

/**
 * The app an earlier run imported a connection's tools into: its own app, or its integration's
 * one app, with which (`scope`), or none.
 */
export const connectionAppOf = (
  store: Pick<ImportStore, "find">,
  snapshot: Pick<V1Snapshot, "connections" | "integrations">,
  row: ConnectionRow,
) =>
  Effect.gen(function* () {
    const integration = snapshot.integrations.find(
      (candidate) => candidate.slug === row.integration,
    );
    if (integration === undefined) return undefined;
    const found = yield* importedApps(store, snapshot, integration);
    const app = found?.kind === "one" ? found.app : found?.apps.get(row.row_id);
    if (found === undefined || app === undefined) return undefined;
    const scope: AppScope = found.kind === "one" ? "integration" : "own";
    return { app, scope, integration };
  });

/** The app an earlier run imported the connection's tools into, unless its users removed it. */
const importedAppOf = (context: ItemContext, row: ConnectionRow) =>
  Effect.gen(function* () {
    const found = yield* connectionAppOf(context.store, context.snapshot, row);
    if (found === undefined) return undefined;
    const app = yield* context.executor.apps
      .get({ owner: organizationOwner(context.target.id), app: found.app })
      .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
    return app === undefined ? undefined : { app, scope: found.scope };
  });

/**
 * Bring the account of a connection an earlier run imported up to date with v1 and its app: it
 * takes v1's final tokens if they are newer (`refreshCopiedGrant`), and follows its app's provider
 * (`followAppProvider`).
 */
export const updateCopiedAccount = (context: ItemContext, row: ConnectionRow, account: AccountId) =>
  Effect.gen(function* () {
    const tokens = yield* refreshCopiedGrant(context, row, account);
    const found = yield* importedAppOf(context, row);
    const followed =
      found !== undefined &&
      (yield* followAppProvider(
        context,
        row,
        found.app.requirements.accounts,
        account,
        found.scope,
      ));
    return { tokens, followed };
  });

/**
 * Check the connection's account as `importAccount` would save it, against the requirements its
 * app's build declares, and save nothing: the dry run's check that every account moves. Its
 * refusals are the import's, with the same reasons. `secret` reads what the import would read
 * from v1's Vault, such as the values the dry run has already read.
 */
export const checkAccount = (
  context: Pick<ItemContext, "executor" | "source" | "firstParty"> & {
    readonly snapshot: ConnectionSnapshot;
    /** Names the check in its errors; nothing is saved under it. */
    readonly owner: OwnerId;
  },
  plan: ConnectionPlan,
  accounts: AppAccountRequirements,
  secret: SecretReader,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const write = yield* accountWrite(context, plan, accounts, context.owner, secret, scope);
    const host = context.executor[OAuthGrantImport];
    if (write.kind === "fields")
      return yield* host.checkAccountFields({
        provider: write.input.provider,
        definition: write.requirement.definition,
        method: write.input.method,
        fields: write.input.fields,
      });
    return yield* host
      .checkOAuthGrant({ ...write.input, definition: write.requirement.definition })
      .pipe(grantRefusals(write, plan.row));
  });

/**
 * Link the connection's account to its app as linking it in v2 does: an org connection's to the
 * app's `workspace` requirement for everyone, by the owner; a member's to its `service`
 * requirement for them (decision 9). Both take many accounts, so every imported connection of an
 * integration stays usable. Linking again changes nothing, so a retried item does not duplicate it.
 */
export const linkConnectionAccount = (
  context: ItemContext,
  row: Pick<ConnectionRow, "owner" | "subject">,
  app: Pick<DeployedApp, "id">,
  account: AccountId,
) =>
  Effect.gen(function* () {
    if (row.owner === "org")
      return yield* linkAppAccount(context.executor, context.sql, {
        app: app.id,
        requirement: connectionRequirement(row),
        account,
        linkedBy: context.owner,
      });
    const member = actorOf(context, row);
    if (member === undefined) return yield* fail("Its member is not imported.");
    return yield* linkUserAccount(context.executor, context.sql, {
      app: app.id,
      requirement: connectionRequirement(row),
      account,
      subject: member,
    });
  });

// ---------------------------------------------------------------------------------------------
// Toolkits.

type RunTarget = ConnectionApp["runsAs"][number];

/** How an earlier item request imported an integration: one app, or an app per connection. */
export type ImportedIntegration =
  | { readonly kind: "one"; readonly id: string }
  | { readonly kind: "split" };

/**
 * What an earlier item request imported: an integration's app, or for an integration imported as
 * an app per connection (decision 33) each connection's own app, and a connection's account and
 * the target its tools run as (its linked account, or the app itself for a public app).
 */
export interface ImportedLookup {
  readonly app: (
    integration: IntegrationRow,
  ) => Effect.Effect<ImportedIntegration | undefined, V1ImportUnavailable>;
  readonly connectionApp: (
    connection: ConnectionRow,
  ) => Effect.Effect<string | undefined, V1ImportUnavailable>;
  readonly connection: (
    connection: ConnectionRow,
  ) => Effect.Effect<
    { readonly target: RunTarget; readonly account: string | null } | undefined,
    V1ImportUnavailable
  >;
}

/**
 * What a connection's tools run as once its account is linked (see `linkConnectionAccount`): an org
 * connection's account is an app link, which a call reaches through the app itself, since a grant
 * names only the caller's own accounts; a member's is their own account.
 */
export const connectionTarget = (
  row: Pick<ConnectionRow, "owner">,
  account: AccountId,
): RunTarget => (row.owner === "org" ? { kind: "app" } : { kind: "account", id: account });

/**
 * The import map's view of earlier item requests. A connection is done once its `profile` row is:
 * the row keeps the kind it had when imports made a profile per connection, so imports started
 * then still read. Its `v2_kind` is `app` for a public app's connection, whose tools run as the
 * app; otherwise the connection's account, recorded in its `connection` row, is linked to the app
 * and its tools run as `connectionTarget` says. Its `v2_id` is the linked account, or, in a row
 * from before profiles were removed, the profile, which the item's result replaces with that
 * account.
 */
export const mapLookup = (
  store: ImportStore,
  snapshot: Pick<V1Snapshot, "connections">,
): ImportedLookup => ({
  app: (integration) =>
    importedApps(store, snapshot, integration).pipe(
      Effect.map((found): ImportedIntegration | undefined =>
        found === undefined
          ? undefined
          : found.kind === "one"
            ? { kind: "one", id: found.app }
            : { kind: "split" },
      ),
    ),
  connectionApp: (connection) =>
    store
      .find("connection_app", connection.row_id)
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
        target: connectionTarget(connection, AccountId.make(account.v2_id)),
        account: account.v2_id,
      };
    }),
});

const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "account" && a.id === b.id;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** `read` once per key; a failed read is not kept, so a later call reads again. */
const readOnce = <R, A, E>(key: (row: R) => string, read: (row: R) => Effect.Effect<A, E>) => {
  const known = new Map<string, { readonly value: A }>();
  return (row: R): Effect.Effect<A, E> => {
    const found = known.get(key(row));
    return found !== undefined
      ? Effect.succeed(found.value)
      : read(row).pipe(Effect.tap((value) => Effect.sync(() => known.set(key(row), { value }))));
  };
};

/** An integration a toolkit reaches, as its app was imported, with every member's tools. */
interface ReachedIntegration {
  readonly imported: ImportedIntegration;
  readonly all: readonly ToolRow[];
  readonly aliases: Readonly<Record<string, string>>;
  /**
   * The names the app a tool runs in leaves out: the integration's one app's, or, for an app per
   * connection, the tool's connection's own app's. None for a tool without its connection there.
   */
  readonly omitted: (connection: ConnectionRow | undefined) => ReadonlySet<string> | undefined;
}

/**
 * What every member's copy of a step's toolkits is planned from, read and decided once for the
 * step: each integration's imported app, tools and the names its app leaves out, each
 * connection's own app and what it runs as, and what each toolkit does with each tool. None of it
 * depends on the member, and a toolkit's copies write none of what `lookup` reads, so every copy
 * reads the same.
 */
export const toolkitPlanning = (
  context: { readonly snapshot: V1Snapshot; readonly source: Pick<V1Source, "tools"> },
  lookup: ImportedLookup,
) => {
  const { snapshot, source } = context;
  // The first of v1's connections at each address, as a tool names its connection.
  const addresses = new Map<string, ConnectionRow>();
  const address = (integration: string, owner: string, subject: string, name: string) =>
    JSON.stringify([integration, owner, subject, name]);
  for (const connection of snapshot.connections) {
    const key = address(
      connection.integration,
      connection.owner,
      connection.subject,
      connection.name,
    );
    if (!addresses.has(key)) addresses.set(key, connection);
  }
  const integration = readOnce(
    (row: IntegrationRow) => row.row_id,
    (row) =>
      Effect.gen(function* () {
        const imported = yield* lookup.app(row);
        if (imported === undefined) return undefined;
        // Approvals are the app's, for every member, so they read every member's tools.
        const all = yield* source.tools(snapshot.tenant, snapshot.subjects, row.slug);
        const aliases = row.plugin_id === "mcp" ? mcpNaming(all).aliases : {};
        const omittedOf = (tools: readonly ToolRow[]) =>
          new Set(approvalRules(toolActions(snapshot, row, tools, aliases)).omitted);
        const integrationOmitted = imported.kind === "one" ? omittedOf(all) : undefined;
        // A connection's own app leaves out what v1's rules blocked for it alone.
        const ownOmitted = new Map<string, ReadonlySet<string>>();
        const omitted = (connection: ConnectionRow | undefined) => {
          if (integrationOmitted !== undefined || connection === undefined)
            return integrationOmitted;
          const own = ownOmitted.get(connection.row_id) ?? omittedOf(listedAs(connection, all));
          ownOmitted.set(connection.row_id, own);
          return own;
        };
        return { imported, all, aliases, omitted } satisfies ReachedIntegration;
      }),
  );
  // What each toolkit does with each tool, which is the same for every member's copy.
  const actions = new Map<V1Toolkit, Map<string, ReturnType<typeof toolkitAction>>>();
  return {
    snapshot,
    integration,
    action: (toolkit: V1Toolkit, toolId: string) => {
      const known = actions.get(toolkit) ?? new Map<string, ReturnType<typeof toolkitAction>>();
      actions.set(toolkit, known);
      if (known.has(toolId)) return known.get(toolId);
      const action = toolkitAction(toolkit, toolId);
      known.set(toolId, action);
      return action;
    },
    /** The connection v1 listed a tool of the integration through. */
    connectionOf: (row: Pick<IntegrationRow, "slug">, tool: ToolRow) =>
      addresses.get(address(row.slug, tool.owner, tool.subject, tool.connection)),
    connectionApp: readOnce((row: ConnectionRow) => row.row_id, lookup.connectionApp),
    connection: readOnce((row: ConnectionRow) => row.row_id, lookup.connection),
  };
};
export type ToolkitPlanning = ReturnType<typeof toolkitPlanning>;

/**
 * A toolkit's scoped MCP connection: for each imported app whose tools it granted, the tools v1
 * served through it (`selected`, by the app's names) and what the connections it granted run as:
 * the app itself for an org connection or a public app's, and a member's own account for theirs. v2 selects an app's tools and accounts
 * separately, so a tool v1 granted for only some of those connections becomes available through
 * all of them; the note says so. An integration imported as an app per connection (decision 33)
 * gives each connection's app the tools granted through that connection, under its own rules.
 *
 * Each member gets their own copy (decision 11), which reaches org connections and, for the
 * member's own toolkit, their own connections; never another member's.
 */
export const toolkitPolicy = (planning: ToolkitPlanning, toolkit: V1Toolkit, member: string) =>
  Effect.gen(function* () {
    const { snapshot } = planning;
    const apps: ConnectionApp[] = [];
    const notes: string[] = [];
    const missingApps = new Set<string>();
    const missingConnections = new Set<string>();
    const blockedElsewhere = new Set<string>();
    const widened = new Set<string>();
    const visible = visibleTo(member);
    const reached = toolkitConnections(snapshot, toolkit).filter(visible);
    for (const integration of snapshot.integrations) {
      if (!reached.some((connection) => connection.integration === integration.slug)) continue;
      const found = yield* planning.integration(integration);
      const label = integrationLabel(integration);
      if (found === undefined) {
        missingApps.add(label);
        continue;
      }
      const { imported, all, aliases } = found;
      const tools = all.filter(visible);
      // The tools granted through each app, the connections granted, and which tool through which.
      const byApp = new Map<
        string,
        { names: Set<string>; granted: Map<string, ConnectionRow>; pairs: Set<string> }
      >();
      for (const tool of tools) {
        const action = planning.action(
          toolkit,
          `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`,
        );
        if (action === undefined || action === "block") continue;
        const name = Object.hasOwn(aliases, tool.name)
          ? (aliases[tool.name] ?? tool.name)
          : tool.name;
        const connection = planning.connectionOf(integration, tool);
        if (found.omitted(connection)?.has(name) === true) {
          blockedElsewhere.add(`${label} ${name}`);
          continue;
        }
        if (connection === undefined) continue;
        const appId =
          imported.kind === "one" ? imported.id : yield* planning.connectionApp(connection);
        if (appId === undefined) {
          missingApps.add(connectionAppName(snapshot, integration, connection));
          continue;
        }
        const entry = byApp.get(appId) ?? {
          names: new Set<string>(),
          granted: new Map<string, ConnectionRow>(),
          pairs: new Set<string>(),
        };
        byApp.set(appId, entry);
        entry.names.add(name);
        entry.granted.set(connection.row_id, connection);
        entry.pairs.add(`${connection.row_id} ${name}`);
      }
      for (const [appId, { names, granted, pairs }] of byApp) {
        const targets: RunTarget[] = [];
        for (const connection of granted.values()) {
          const target = (yield* planning.connection(connection))?.target;
          if (target === undefined) missingConnections.add(`${label} ${connection.name}`);
          else if (!targets.some((other) => sameTarget(other, target))) targets.push(target);
        }
        const [first, ...rest] = targets;
        if (first === undefined) continue;
        if (names.size * granted.size > pairs.size) widened.add(label);
        apps.push({
          app: AppId.make(appId),
          runsAs: [first, ...rest],
          tools: { kind: "selected", names: [...names].sort().map((name) => ToolName.make(name)) },
        });
      }
    }
    if (reached.length === 0) notes.push(grantsNoConnection);
    if (missingApps.size > 0)
      notes.push(`Not imported, so left out: ${[...missingApps].join(", ")}.`);
    if (missingConnections.size > 0)
      notes.push(
        `${plural(missingConnections.size, "connection was", "connections were")} not imported and ${missingConnections.size === 1 ? "is" : "are"} left out: ${[...missingConnections].join(", ")}.`,
      );
    if (blockedElsewhere.size > 0)
      notes.push(
        `${plural(blockedElsewhere.size, "tool", "tools")} v1 allowed only through this toolkit ${blockedElsewhere.size === 1 ? "is" : "are"} blocked in the workspace, so ${blockedElsewhere.size === 1 ? "it is" : "they are"} left out: ${[...blockedElsewhere].sort().join(", ")}.`,
      );
    if (widened.size > 0)
      notes.push(
        `v2 grants an app's selected tools through every selected account, so some tools are now available through more accounts of ${[...widened].join(", ")} than in v1.`,
      );
    if (toolkit.access.some((pattern) => pattern.split(".")[0] === "executor"))
      notes.push("It granted v1's built-in tools, which v2 does not have.");
    return { policy: { apps } satisfies ConnectionPolicy, notes };
  });

/**
 * The connection's id: stable for the toolkit, the member's copy, the organization and the
 * generation, so a retry updates it.
 */
export const toolkitConnectionId = (
  organization: string,
  toolkit: V1Toolkit,
  member: string,
  generation: number,
) =>
  toolkitCopyConnectionId(organization, toolkit.row.row_id, member, generation).pipe(
    Effect.map((id) => ConnectionId.make(id)),
  );

/**
 * What the import map holds for one member's copy of a toolkit: the connection an earlier run saved
 * it as, a row for an attempt that saved none, or no row at all. Only a rollback deletes map rows,
 * so a connection that already holds an unmapped copy's id was made by an import that was rolled
 * back.
 */
export type ToolkitCopyRecord =
  | { readonly kind: "saved"; readonly connection: string }
  | { readonly kind: "unsaved" }
  | { readonly kind: "unmapped" };

/** The members who get a copy of a toolkit: everyone for an org toolkit, else its owner. */
export const toolkitMembers = (toolkit: V1Toolkit, members: readonly string[]) =>
  toolkit.row.owner === "org"
    ? members
    : members.filter((member) => member === toolkit.row.subject);

/** The map key of one member's copy of a toolkit. */
export const toolkitCopyKey = (toolkit: Pick<V1Toolkit, "row">, member: string) =>
  toolkitCopyId(toolkit.row.row_id, member);

/**
 * Create or update a member's copy of the toolkit: a scoped MCP connection they own. A copy the
 * import map records keeps its connection, which for a copy the opt-in import made is not the id an
 * import gives a copy now. Any other copy takes generation 0's id. When another connection holds
 * an unmapped copy's id, one a rolled-back import made, the copy takes the next generation's: that
 * connection stays revoked under its id, so its grants and tokens never come back. Otherwise a
 * taken id means its users removed the copy. `planning` is the step's, shared by every copy it
 * saves.
 */
export const importToolkit = (
  context: ItemContext,
  planning: ToolkitPlanning,
  toolkit: V1Toolkit,
  member: string,
  record: ToolkitCopyRecord,
) =>
  Effect.gen(function* () {
    const user = context.users.get(member);
    if (user === undefined) return yield* fail("Its member is not imported.");
    const { policy, notes } = yield* toolkitPolicy(planning, toolkit, member);
    const owner = { userId: user, resource: context.target.id };
    const name = (toolkit.data.name.trim() === "" ? toolkit.data.slug : toolkit.data.name).slice(
      0,
      80,
    );
    const note = notes.length === 0 ? undefined : notes.join(" ");
    const live = yield* context.connections.list(owner);
    const save = (id: ConnectionId) =>
      Effect.gen(function* () {
        return live.some((connection) => connection.id === id)
          ? yield* context.connections.update(owner, { id, name, policy })
          : yield* context.connections.create(owner, { id, name, policy });
      });
    if (record.kind === "saved") {
      const saved = yield* save(ConnectionId.make(record.connection));
      return imported("mcp_connection", saved.id, note);
    }
    // Each rollback leaves at most one generation of a copy behind, so the walk ends at the first
    // generation after them. A retry finds the copy it saved there live and updates it.
    for (let generation = 0; ; generation++) {
      const id = yield* toolkitConnectionId(context.target.id, toolkit, member, generation);
      const saved = yield* save(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ConnectionIdTaken", (taken) =>
          record.kind === "unmapped" ? Effect.succeedNone : Effect.fail(taken),
        ),
      );
      if (Option.isSome(saved)) return imported("mcp_connection", saved.value.id, note);
    }
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

/** Why a role v1 left unbound maps to no app of an integration imported per connection. */
const unboundSplit =
  "v1 bound no connection to it, and its integration became an app per connection.";

/**
 * Each role's imported app and linked account, read from the import map. A role of an integration
 * imported as an app per connection (decision 33) maps to its bound connection's own app.
 */
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
        const found = yield* lookup.app(integration);
        if (found === undefined) return mapping({ problem: "Its integration was not imported." });
        if (found.kind === "split") {
          if (use.binding === undefined) return mapping({ problem: unboundSplit });
          if (connection === undefined)
            return mapping({ problem: "Its connection no longer exists in v1." });
        }
        const appId =
          found.kind === "one"
            ? found.id
            : connection === undefined
              ? undefined
              : yield* lookup.connectionApp(connection);
        if (appId === undefined)
          return mapping({ problem: "Its connection's app was not imported." });
        const app = {
          id: appId,
          name:
            found.kind === "one" || connection === undefined
              ? integrationLabel(integration)
              : connectionAppName(snapshot, integration, connection),
        };
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
 * Save the artifact as a private app without a version: `apps.create` keeps its source and builds
 * nothing, so it does not run until it is repaired. An earlier import's app gets a new commit.
 */
export const importArtifact = (
  context: ItemContext,
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    // An org artifact's creator is the owner; a member's artifact stays theirs.
    const creator = actorOf(context, row);
    if (creator === undefined) return yield* fail("Its member is not imported.");
    return yield* saveArtifact(context, row, mapping, existing).pipe(
      Effect.provideService(CurrentUserId, creator),
    );
  });

const saveArtifact = (
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
    for (const candidate of appNames(artifactNaming(row))) {
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
    return yield* fail(namesTaken);
  });
