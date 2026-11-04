/**
 * What an import of one v1 organization does with each item, decided from v1's rows alone. Each
 * step decides again from fresh rows before writing.
 */
import type { FirstPartyOAuthClientDescription } from "@executor-js/sdk/core";
import { reservedAuthorizationParams } from "apps/contracts";
import { Option, Schema } from "effect";
import {
  OAuthGrantKind,
  artifactUses,
  connectionClient,
  credentialLike,
  decodeIntegration,
  decodeItemIds,
  decodeToolkits,
  firstPartyClientPrefix,
  placementVariables,
  tokenEndpointAuthMethod,
  tokenVariable,
  toolkitReaches,
  validPattern,
  type ArtifactRow,
  type ConnectionRow,
  type IntegrationRow,
  type OAuthClientRow,
  type PolicyRow,
  type V1AuthMethod,
  type V1Integration,
  type V1Toolkit,
} from "./formats.ts";
import type { V1StaleCategory } from "../../contracts/v1-import-run.ts";
import type { V1Snapshot } from "./source.ts";

export type Supported<A> = { readonly ok: true; readonly value: A };
/**
 * Why an item does not move. `stale` names why v1 cannot run it either, which skips it and does
 * not block its organization (decision 20); null blocks the organization until the importer
 * handles it.
 */
export type Unsupported = {
  readonly ok: false;
  readonly reason: string;
  readonly stale: V1StaleCategory | null;
};
const supported = <A>(value: A): Supported<A> => ({ ok: true, value });
const unsupported = (reason: string): Unsupported => ({ ok: false, reason, stale: null });
const stale = (category: V1StaleCategory, reason: string): Unsupported => ({
  ok: false,
  reason,
  stale: category,
});
const mapSupported = <A, B>(
  result: Supported<A> | Unsupported,
  f: (value: A) => B,
): Supported<B> | Unsupported => (result.ok ? supported(f(result.value)) : result);

export type ImportableIntegration = Exclude<V1Integration, { readonly plugin: "unsupported" }>;

/** How one connection becomes a v2 account, once its integration is an app. */
export type ConnectionAccess =
  | { readonly kind: "none" }
  | {
      readonly kind: "secrets";
      readonly placements: Extract<V1AuthMethod, { kind: "apikey" }>["placements"];
      /** Variable name to v1 Vault item id. */
      readonly items: ReadonlyArray<readonly [string, string]>;
    }
  | ({
      readonly kind: "oauth";
      readonly method: Extract<V1AuthMethod, { kind: "oauth2" }>;
      readonly client: OAuthClientRow;
      readonly authentication:
        | "none"
        | "client_secret_post"
        | "client_secret_basic"
        | "client_secret_basic_raw";
      readonly accessItem: string;
      /** How v1 renewed the connection's token; see {@link v1Renewal}. */
      readonly renewal: {
        readonly tokenEndpoint: string;
        readonly scopes: readonly string[];
        readonly resource?: string | undefined;
      };
    } & (
      | { readonly grant: "client_credentials" }
      | {
          readonly grant: "authorization_code";
          /**
           * Where v2 signs in: the request v1 sent at the client's endpoints (see
           * {@link v1Authorization}), or, for an MCP server, the endpoints the server names.
           */
          readonly authorization:
            | ({ readonly kind: "declared" } & V1AuthorizationRequest)
            | { readonly kind: "discover"; readonly url: string };
        }
    ))
  | {
      /** Signed in through one of Executor's own OAuth apps, which v2 offers as the same client. */
      readonly kind: "first_party";
      readonly method: Extract<V1AuthMethod, { kind: "oauth2" }>;
      readonly client: FirstPartyOAuthClientDescription;
      readonly accessItem: string;
      /** What the app's method asks for at sign-in; see {@link firstPartySignIn}. */
      readonly scopes: readonly string[];
      /** The scopes the connection was granted, which renewals ask for again, as v1's did. */
      readonly renewal: { readonly scopes: readonly string[] };
    };

/**
 * The operator's OAuth client v2 offers under one of v1's first-party names (`google` for
 * `first-party:google`), or undefined when it offers none: the client's credentials are not set.
 */
export type FirstPartyClients = (name: string) => FirstPartyOAuthClientDescription | undefined;

export interface ConnectionPlan {
  readonly row: ConnectionRow;
  readonly integration: IntegrationRow;
  readonly decoded: ImportableIntegration;
  readonly access: ConnectionAccess;
}

export const integrationLabel = (row: IntegrationRow) => row.name ?? row.slug;

const firstPartyNames: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  clickup: "ClickUp",
};
/** The provider of one of Executor's own OAuth apps, as people know it: `google` is Google. */
export const firstPartyName = (name: string) =>
  firstPartyNames[name] ?? `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** The scopes v1 recorded a connection was granted; none when it recorded none. */
const grantedScopes = (row: ConnectionRow) =>
  (row.oauth_scope ?? "").split(/\s+/).filter((scope) => scope !== "");

/**
 * What an imported app's method asks for when it signs in with one of the operator's clients. A
 * client that allows no scopes, as the GitHub App's, is offered only to a method that asks for
 * none, and v1 asked it for none whatever the integration declared. Any other client asks for
 * the integration's scopes, as v1 did, which must all be ones the client allows.
 */
const firstPartySignIn = (
  client: FirstPartyOAuthClientDescription,
  method: Extract<V1AuthMethod, { kind: "oauth2" }>,
) => {
  const allowed = client.allowedScopes ?? client.defaultScopes;
  if (allowed.length === 0) return [];
  return method.scopes.every((scope) => allowed.includes(scope)) ? method.scopes : undefined;
};

const httpUrl = (value: string) =>
  URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);

/**
 * Datadog's commercial regions. v1 redeemed a code at the region its callback named and recorded
 * that token endpoint; it trusted a recorded endpoint only as one of these in place of another.
 */
const datadogTokenHosts: ReadonlySet<string> = new Set([
  "app.datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
]);

/**
 * The token endpoint v1 refreshed a connection at (v1's `tokenEndpointForRefresh`): its client's,
 * or the one recorded when the code was redeemed if that is the client's with only its Datadog
 * region changed. Undefined for a recorded endpoint v1 no longer trusted, which v1 made reconnect.
 */
export const refreshTokenEndpoint = (client: string, recorded: string | null) => {
  if (recorded === null || recorded === client) return client;
  if (!URL.canParse(recorded) || !URL.canParse(client)) return undefined;
  const persisted = new URL(recorded);
  const plain = (url: URL) =>
    url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "";
  const configured = new URL(client);
  const host = persisted.hostname.toLowerCase();
  const regional =
    plain(configured) &&
    plain(persisted) &&
    datadogTokenHosts.has(configured.hostname.toLowerCase()) &&
    datadogTokenHosts.has(host);
  if (regional) configured.hostname = host;
  const trusted = regional ? configured.href : client;
  return new URL(trusted).href === persisted.href ? trusted : undefined;
};

/**
 * How v1 renewed a connection's token, from its OAuth client and not its integration's method,
 * whose endpoints and scopes v1 used only to create the client: the token endpoint above, the
 * scopes the connection was granted (none when it recorded none) and the client's RFC 8707
 * resource.
 */
const v1Renewal = (row: ConnectionRow, client: OAuthClientRow, tokenEndpoint: string) => ({
  tokenEndpoint,
  scopes: grantedScopes(row),
  ...(client.resource === null || client.resource === "" ? {} : { resource: client.resource }),
});

/** An authorization endpoint without host-owned parameters, and the scopes v1 asked for there. */
export interface V1AuthorizationRequest {
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
}

/** The parameters v1 set on every authorization request, replacing the URL's own. */
const v1SetAlways: ReadonlySet<string> = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

const v1AuthorizationRefused = (problem: string) =>
  unsupported(
    `Its OAuth client's authorization URL ${problem}, which an Executor v2 sign-in method cannot send as v1 did. Reconnect it in v2.`,
  );

/**
 * The authorization request v1 sent from a client's URL, as v2 declares it, or why v2 cannot send
 * it. v1 kept the URL's query and set the protocol parameters over it (`buildAuthorizationUrl`):
 * those it always set never reached the server, `scope` only when the method declared scopes and
 * `resource` only when the client named one. A v2 declaration leaves every protocol parameter to
 * the host, so the rest are removed from the URL and declared instead, only where the host sends
 * exactly what v1 did:
 *
 * - A `scope` v1 sent from the URL becomes the method's scopes, split at each space, which the host
 *   joins back with one. Any other character, such as Linear's comma or a tab, stays inside a scope,
 *   and an empty `scope` or two spaces together leave an empty one, so the host sends the value v1
 *   sent. A repeated `scope` has no such form.
 * - A `resource` v1 sent from the URL went only to the authorization endpoint, while a declared
 *   resource also goes to the token endpoint.
 * - Any other protocol parameter, such as `nonce`, has no v2 equivalent.
 */
export const v1Authorization = (
  client: Pick<OAuthClientRow, "authorization_url" | "resource">,
  scopes: readonly string[],
): Supported<V1AuthorizationRequest> | Unsupported => {
  const url = new URL(client.authorization_url);
  const reserved = new Set<string>(reservedAuthorizationParams);
  const sent = [...new Set(url.searchParams.keys())].filter((key) => reserved.has(key));
  const unrepresentable = sent.filter(
    (key) => !v1SetAlways.has(key) && key !== "scope" && key !== "resource",
  );
  if (unrepresentable.length > 0)
    return unsupported(
      `Its OAuth client's authorization URL sets ${unrepresentable.join(", ")}, which an Executor v2 sign-in method cannot send. Reconnect it in v2.`,
    );
  const clientResource = client.resource !== null && client.resource !== "";
  if (!clientResource && url.searchParams.has("resource"))
    return unsupported(
      "Its OAuth client's authorization URL sets resource, which v1 sent only when signing in and an Executor v2 sign-in method would also send when exchanging and refreshing tokens. Reconnect it in v2.",
    );
  const urlScopes = url.searchParams.getAll("scope");
  const sentScopes = (): Supported<readonly string[]> | Unsupported => {
    if (scopes.length > 0 || urlScopes.length === 0) return supported(scopes);
    if (urlScopes.length > 1) return v1AuthorizationRefused("sets scope more than once");
    return supported((urlScopes[0] ?? "").split(" "));
  };
  const requested = sentScopes();
  if (!requested.ok) return requested;
  for (const key of sent) url.searchParams.delete(key);
  return supported({ authorizationUrl: url.href, scopes: requested.value });
};

/** A credential v1's configuration sent on every request, which becomes an account field. */
export interface ConfigSecret {
  readonly carrier: "header" | "query";
  readonly name: string;
  /** The account field that holds it. */
  readonly field: string;
  readonly value: string;
}

/**
 * The integration's fixed headers and query parameters, split into credentials (`credentialLike`),
 * which the app's accounts carry as fields, and the rest, which stay in its source. Credentials in
 * `dropped`, by field, are left out (see `redundantFixed`).
 */
export const integrationValues = (
  decoded: ImportableIntegration,
  dropped: ReadonlySet<string> = new Set(),
) => {
  const secrets: ConfigSecret[] = [];
  const split = (carrier: ConfigSecret["carrier"], values: Readonly<Record<string, string>>) => {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const field = `fixed ${carrier} ${name}`;
      if (!credentialLike(name, value)) kept[name] = value;
      else if (!dropped.has(field)) secrets.push({ carrier, name, field, value });
    }
    return kept;
  };
  const headers = split("header", decoded.config.headers ?? {});
  const queryParams = split("query", decoded.config.queryParams ?? {});
  return { secrets, headers, queryParams };
};

/** Whether a method's own placement replaces a fixed value: same carrier and name. */
export const replaces = (
  placement: { readonly carrier: "header" | "query"; readonly name: string },
  secret: ConfigSecret,
) =>
  placement.carrier === secret.carrier &&
  (secret.carrier === "header"
    ? placement.name.toLowerCase() === secret.name.toLowerCase()
    : placement.name === secret.name);

export const integrationPlan = (
  row: IntegrationRow,
): Supported<ImportableIntegration> | Unsupported => {
  const decoded = decodeIntegration(row);
  return decoded.plugin === "unsupported"
    ? { ok: false, reason: decoded.reason, stale: decoded.stale }
    : supported(decoded);
};

/**
 * The integration method a connection signs in with. v1 sends a connection's credential without
 * checking its template against the integration, so a connection whose template slug the
 * integration later renamed (`googleOAuth2` before `oauth-googleOAuth2`) still works there. Such a
 * connection takes the integration's one method of the same kind; `none` needs no method.
 */
const connectionMethod = (
  methods: ReadonlyMap<string, V1AuthMethod>,
  row: ConnectionRow,
): V1AuthMethod | undefined => {
  const declared = methods.get(row.template);
  if (declared !== undefined) return declared;
  if (row.template === "none") return { kind: "none" };
  const kind = row.oauth_client === null ? "apikey" : "oauth2";
  const candidates = [...methods.values()].filter((method) => method.kind === kind);
  return candidates.length === 1 ? candidates[0] : undefined;
};

/** Decide a connection from its integration's methods and, for OAuth, its client row. */
export const connectionPlan = (
  snapshot: Pick<V1Snapshot, "integrations" | "clients">,
  firstParty: FirstPartyClients,
  row: ConnectionRow,
): Supported<ConnectionPlan> | Unsupported => {
  const integration = snapshot.integrations.find((candidate) => candidate.slug === row.integration);
  if (integration === undefined) return unsupported("Its integration no longer exists in v1.");
  const decoded = integrationPlan(integration);
  if (!decoded.ok)
    return { ok: false, reason: "Its integration cannot be imported.", stale: decoded.stale };
  if (row.provider !== "workos-vault")
    return stale(
      "missing_credential",
      "Its saved credential could not be found in v1. Reconnect it in v2.",
    );
  const method = connectionMethod(decoded.value.methods, row);
  if (method === undefined)
    return stale(
      "undeclared_method",
      "Its sign-in method is not one its integration declares. Reconnect it in v2.",
    );
  const plan = (access: ConnectionAccess) =>
    supported({ row, integration, decoded: decoded.value, access });
  const items = Option.getOrUndefined(decodeItemIds(row.item_ids));
  switch (method.kind) {
    case "unsupported":
      return unsupported(method.reason);
    case "none":
      return plan({ kind: "none" });
    case "apikey": {
      const variables = placementVariables(method.placements);
      const found = variables.map((variable) => [variable, items?.[variable]] as const);
      if (found.some(([, item]) => item === undefined))
        return stale(
          "incomplete_credential",
          "Its saved credential is incomplete. Reconnect it in v2.",
        );
      return plan({
        kind: "secrets",
        placements: method.placements,
        items: found.flatMap(([variable, item]) => (item === undefined ? [] : [[variable, item]])),
      });
    }
    case "oauth2": {
      if (method.enterprise) return unsupported("Enterprise-managed OAuth is not supported.");
      // A connection of an OAuth method without a client holds a token v1 never renewed: v1
      // sent its saved token where the method puts an access token (`resolveConnectionValues`
      // reads `item_ids` when a row has no client), so it moves as that fixed credential.
      if (row.oauth_client === null) {
        const placements = [
          { carrier: "header", name: method.header, prefix: method.prefix },
        ] as const;
        if (items?.[tokenVariable] === undefined)
          return stale(
            "incomplete_credential",
            "Its saved credential is incomplete. Reconnect it in v2.",
          );
        return plan({
          kind: "secrets",
          placements,
          items: [[tokenVariable, items[tokenVariable]]],
        });
      }
      // An OAuth account holds only its token; the fixed credentials it does not replace go in
      // the app's account for them (`appMethods`, decision 22).
      if (row.oauth_client.startsWith(firstPartyClientPrefix)) {
        // v1's first-party connections move to v2's client of the same name. Production
        // configures each such client with v1's client ID and secret, so the refresh tokens copied
        // from v1 are valid for it; a v2 client under a v1 name must always be v1's client.
        const name = row.oauth_client.slice(firstPartyClientPrefix.length);
        const label = firstPartyName(name);
        const client = firstParty(name);
        if (client === undefined)
          return unsupported(
            `It signed in through Executor's own ${label} app, which Executor v2 does not offer yet. Reconnect it in v2.`,
          );
        const accessItem = items?.[tokenVariable];
        if (accessItem === undefined)
          return stale(
            "incomplete_credential",
            "Its saved sign-in is incomplete. Reconnect it in v2.",
          );
        // v1 renewed with the scopes the connection was granted, and v2's client renews only a
        // grant whose scopes it allows. Its allowed scopes are reviewed code, so a grant beyond
        // them reconnects rather than widening them.
        const allowed = client.allowedScopes ?? client.defaultScopes;
        const granted = grantedScopes(row);
        if (!granted.every((scope) => allowed.includes(scope)))
          return unsupported(
            `It was granted permissions Executor v2's own ${label} app does not allow. Reconnect it in v2.`,
          );
        const scopes = firstPartySignIn(client, method);
        if (scopes === undefined)
          return unsupported(
            `Its integration asks for permissions Executor v2's own ${label} app does not allow. Reconnect it in v2.`,
          );
        return plan({
          kind: "first_party",
          method,
          client,
          accessItem,
          scopes,
          renewal: { scopes: granted },
        });
      }
      const client = connectionClient(row, snapshot.clients);
      if (client === undefined)
        return stale(
          "missing_client",
          "Its OAuth client no longer exists in v1. Reconnect it in v2.",
        );
      const grant = Schema.decodeUnknownOption(OAuthGrantKind)(client.grant);
      if (Option.isNone(grant)) return unsupported("Its OAuth client uses an unknown grant.");
      if (grant.value === "id_jag")
        return unsupported("Enterprise-managed OAuth is not supported.");
      const secret = tokenEndpointAuthMethod(client.token_endpoint_auth_method);
      if (secret === undefined)
        return unsupported("Its OAuth client uses an unknown client authentication.");
      if (grant.value === "client_credentials" && client.client_secret_item_id === null)
        return unsupported("Its OAuth client has no secret for the client credentials grant.");
      const accessItem = items?.[tokenVariable];
      if (accessItem === undefined)
        return stale(
          "incomplete_credential",
          "Its saved sign-in is incomplete. Reconnect it in v2.",
        );
      // v1 signed in and renewed at the client's endpoints, whatever the method declared. The app
      // declares them, so each must be an HTTP(S) URL; v1 stores `""` for one a flow does not use.
      if (!httpUrl(client.token_url)) return unsupported("Its OAuth client has no token endpoint.");
      if (
        grant.value === "authorization_code" &&
        decoded.value.plugin !== "mcp" &&
        !httpUrl(client.authorization_url)
      )
        return unsupported("Its OAuth client has no authorization endpoint.");
      if (client.resource !== null && client.resource !== "" && !httpUrl(client.resource))
        return unsupported("Its OAuth client's resource is not a URL.");
      const signIn =
        grant.value === "client_credentials"
          ? supported({ grant: "client_credentials" as const })
          : decoded.value.plugin === "mcp"
            ? supported({
                grant: "authorization_code" as const,
                authorization: { kind: "discover" as const, url: decoded.value.config.endpoint },
              })
            : mapSupported(v1Authorization(client, method.scopes), (request) => ({
                grant: "authorization_code" as const,
                authorization: { kind: "declared" as const, ...request },
              }));
      if (!signIn.ok) return signIn;
      const tokenEndpoint = refreshTokenEndpoint(client.token_url, row.oauth_token_url);
      if (tokenEndpoint === undefined)
        return unsupported(
          "v1 no longer trusted the token endpoint its sign-in recorded. Reconnect it in v2.",
        );
      return plan({
        kind: "oauth",
        method,
        ...signIn.value,
        client,
        authentication: client.client_secret_item_id === null ? "none" : secret,
        accessItem,
        renewal: v1Renewal(row, client, tokenEndpoint),
      });
    }
  }
};

/** The workspace's toolkits that decode, with their rules. */
export const decodedToolkits = (snapshot: Pick<V1Snapshot, "toolkits" | "toolkitRules">) =>
  decodeToolkits(snapshot.toolkits, snapshot.toolkitRules);

/** The note on a toolkit whose access patterns reach none of the workspace's connections. */
export const grantsNoConnection = "It grants no connection in this workspace.";

/** The connections whose tools a toolkit can reach, from their addresses alone. */
export const toolkitConnections = (snapshot: Pick<V1Snapshot, "connections">, toolkit: V1Toolkit) =>
  snapshot.connections.filter((connection) =>
    toolkitReaches(toolkit, [connection.integration, connection.owner, connection.name]),
  );

/**
 * Why an artifact needs repair in v2, for every artifact: its code calls other integrations'
 * tools from the browser, and a v2 app's page can call only its own app's tools.
 */
export const artifactRepairNote =
  "It is imported as app source without a version: v2 apps cannot call other apps' tools yet, so its code needs rewriting before it runs.";

/**
 * The v1 rows an artifact's code calls through: each role's integration and bound connection, or
 * why the role has none. Roles that name the same connection share its rows.
 */
export const artifactPlan = (
  snapshot: Pick<V1Snapshot, "integrations" | "connections">,
  row: ArtifactRow,
) => {
  const { uses, builtIn } = artifactUses(row);
  const roles = uses.map((use) => {
    const integration = snapshot.integrations.find(
      (candidate) => candidate.slug === (use.binding?.integration ?? use.integration),
    );
    const binding = use.binding;
    const connection =
      binding === undefined
        ? undefined
        : snapshot.connections.find(
            (candidate) =>
              candidate.integration === binding.integration &&
              candidate.owner === binding.owner &&
              // A member's artifact binds their own connections; others' are not theirs to use.
              (candidate.owner === "org" || candidate.subject === row.subject) &&
              candidate.name === binding.connection,
          );
    return { use, integration, connection };
  });
  const unique = <A extends { readonly row_id: string }>(rows: ReadonlyArray<A | undefined>) => [
    ...new Map(
      rows.flatMap((row) => (row === undefined ? [] : [[row.row_id, row] as const])),
    ).values(),
  ];
  return {
    roles,
    builtIn,
    integrations: unique(roles.map((role) => role.integration)),
    connections: unique(roles.map((role) => role.connection)),
  };
};

/**
 * What a tool policy does: move into the apps of the integrations it names, or nothing when v1
 * never applied it.
 */
export const policyPlan = (
  snapshot: Pick<V1Snapshot, "integrations">,
  row: Pick<PolicyRow, "pattern" | "action">,
):
  | { readonly status: "will_import"; readonly integrations: readonly IntegrationRow[] }
  | { readonly status: "skipped"; readonly reason: string } => {
  const first = row.pattern.split(".")[0] ?? "";
  const targets = snapshot.integrations.filter(
    (integration) => first === "*" || integration.slug === first,
  );
  const valid =
    validPattern(row.pattern) &&
    ["approve", "require_approval", "block"].includes(row.action) &&
    targets.length > 0;
  // A rule v1 never applied has nothing to import; it is not a failure.
  return valid
    ? { status: "will_import", integrations: targets }
    : {
        status: "skipped",
        reason:
          targets.length > 0
            ? "v1 never applied this rule."
            : first === "*"
              ? "The workspace has no integrations for it to apply to."
              : first === "executor"
                ? "It applies to v1's built-in tools, which v2 does not have."
                : "Its integration no longer exists in v1.",
      };
};
