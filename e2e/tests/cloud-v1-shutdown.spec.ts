/**
 * Executor v1's shutdown (`notes/v1-shutdown.md`): once `executor.sh` is routed to v2, Cloud's edge
 * serves every MCP URL v1 issued and its discovery, signs their clients in to v2, accepts the
 * WorkOS API keys v1 captured while it still forwarded, and serves v1's documents, redirects and
 * a 410 for v1's API. The edge (`edge.` beside the deployment) stands in for `executor.sh`; v1's
 * edge forwards none of these paths before the switch, so requesting them here is what the
 * switch does.
 *
 * v1 organizations reach the edge only through Cloud's lookup table (`private_v1_legacy_org`),
 * which imports and the backfill write. Scenarios that need no import write its rows directly,
 * for synthetic organization ids and slugs, as the backfill would.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { writeRows } from "../support/cloud-rows.ts";
import { Emulators } from "../support/emulators.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Execution, consentTo } from "../support/mcp-connections.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target, driver } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { allowV1Import, v1ImportOperator, v1RunId } from "../support/v1-import.ts";
import { scenarios } from "../test-plan.ts";

const Identity = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const CreatedKey = Schema.Struct({ key: Schema.String });
const Whoami = Schema.Struct({
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String }),
  access: Schema.Struct({ kind: Schema.String, id: Schema.optional(Schema.String) }),
});
const Discovery = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  scopes_supported: Schema.Array(Schema.String),
  bearer_methods_supported: Schema.Array(Schema.String),
  resource_name: Schema.String,
});
const Search = Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) });

/** The user a session belongs to. */
const userOf = (session: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* body(Identity, yield* api.request(session, "GET", "/api/auth/get-session"))).user
      .id;
  });

/** What Better Auth stores for a key: the unpadded base64url SHA-256 of its value. */
const keyHash = (key: string) => createHash("sha256").update(key).digest("base64url");

/** A synthetic WorkOS organization id. */
const v1OrganizationId = () => `org_${randomBytes(13).toString("hex").toUpperCase()}`;
/** A synthetic v1 slug, lowercase like v1's. */
const v1Slug = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

/** A v1 organization that moved to `v2`, as the import or the backfill records it. */
const movedV1Organization = (v2: string, slug = v1Slug("v1")) =>
  Effect.gen(function* () {
    const id = v1OrganizationId();
    yield* writeRows("sso-database.json", [
      {
        sql: "insert into private_v1_legacy_org (v1_org_id, v1_slug, v2_org_id) values ($1, $2, $3)",
        params: [id, slug, v2],
      },
    ]);
    return { id, slug };
  });

/** Another team's v2 organization, nobody in the scenario a member of it. */
const otherV2Organization = (slug: string) =>
  Effect.gen(function* () {
    const id = `org-${randomUUID()}`;
    yield* writeRows("sso-database.json", [
      {
        sql: `insert into organization (id, name, slug, "createdAt") values ($1, 'Another team', $2, now())`,
        params: [id, slug],
      },
    ]);
    return { id, slug };
  });

/** A member's copy of a v1 toolkit, as the import records it. */
const toolkitCopy = (input: {
  readonly v1Organization: string;
  readonly toolkit: string;
  readonly user: string;
  readonly connection: string;
}) =>
  writeRows("sso-database.json", [
    {
      sql: `insert into private_v1_legacy_toolkit
        (v1_org_id, toolkit_slug, v2_user_id, connection_id, v1_toolkit_row, org_owned)
        values ($1, $2, $3, $4, $5, true)`,
      params: [
        input.v1Organization,
        input.toolkit,
        input.user,
        input.connection,
        `toolkit-row-${randomUUID()}`,
      ],
    },
  ]);

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "v1 client", version: "1" },
  },
});

/** An MCP `initialize` to `url`, with `bearer` when given. */
const initializeAt = (url: string, bearer?: string) =>
  rawRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: initialize,
  });

/** An access token as AuthKit issued them: a JWT from another issuer. */
const authKitToken = () =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: "https://signin.example.test",
        sub: "user_SYNTHETIC",
        org_id: "org_SYNTHETIC",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url"),
    randomBytes(32).toString("base64url"),
  ].join(".");

/** The challenge a legacy URL's 401 carries: its own discovery document. */
const challengeFor = (edge: string, path: string, mode = "model") =>
  `Bearer resource_metadata="${edge}/.well-known/oauth-protected-resource${path}?elicitation_mode=${mode}", scope="mcp offline_access"`;

/** What the edge's discovery document says for `path`. */
const discovered = (edge: string, path: string) =>
  Effect.gen(function* () {
    const response = yield* rawRequest(`${edge}/.well-known/oauth-protected-resource${path}`);
    expect(response.status, path).toBe(200);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Discovery))(response.text);
  });

const expectDiscovery = (edge: string, path: string) =>
  Effect.gen(function* () {
    expect(yield* discovered(edge, path), path).toEqual({
      resource: `${edge}${path}`,
      authorization_servers: [`${edge}/api/auth`],
      scopes_supported: ["mcp", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "Executor",
    });
  });

/** What a bearer reaches, as `/mcp/whoami` on the edge says. */
const whoami = (edge: string, bearer: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const response = yield* rawRequest(`${edge}/mcp/whoami`, {
      headers: { authorization: `Bearer ${Redacted.value(bearer)}` },
    });
    expect(response.status, response.text).toBe(200);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Whoami))(response.text);
  });

/** A personal access token, unpinned or pinned to an organization. */
const personalToken = (session: Session, organization?: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const created = yield* api.request(session, "POST", "/api/auth/api-key/create", {
      name: `v1 shutdown ${randomUUID().slice(0, 6)}`,
      ...(organization === undefined ? {} : { metadata: { organization } }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return Redacted.make((yield* body(CreatedKey, created)).key);
  });

/** How many apps' tools an MCP client can search: none when its access selects no app. */
const searchable = (client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>) =>
  client
    .use("Search every tool", (client, signal) =>
      client.callTool(
        {
          name: "execute",
          arguments: { code: `return await tools.search({ query: "executor", limit: 50 })` },
        },
        undefined,
        { signal },
      ),
    )
    .pipe(
      Effect.flatMap((result) => Schema.decodeUnknownEffect(Execution)(result.structuredContent)),
      Effect.flatMap((done) => Schema.decodeUnknownEffect(Search)(done.execution.value)),
      Effect.map((found) => found.items.length),
    );

const listTools = (client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>) =>
  client
    .use("List tools", (client, signal) => client.listTools(undefined, { signal }))
    .pipe(Effect.map((listed) => listed.tools.map((tool) => tool.name)));

layer(HostedLive, { excludeTestServices: true })("Cloud after v1's shutdown", (it) => {
  it.effect(scenarios.v1ShutdownMcpUrls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          mcp = yield* McpClient,
          target = yield* Target;
        const { edge, mcp: mcpOrigin } = targetHosts(target);
        const organization = actors.organization;
        // A v1 slug that another team's v2 organization now holds as its own slug.
        const held = yield* otherV2Organization(v1Slug("held"));
        const moved = yield* movedV1Organization(organization.id, held.slug);
        // Two v1 organizations merged into the same v2 organization.
        const merged = yield* movedV1Organization(organization.id);
        // A v1 organization that moved to the other team's organization.
        const elsewhere = yield* movedV1Organization(held.id);
        const unknown = v1Slug("unknown");

        // Discovery names each URL as its own resource and v2's issuer on `executor.sh`.
        for (const path of [
          `/${moved.slug}/mcp`,
          `/${moved.id}/mcp`,
          `/${merged.slug}/mcp`,
          "/mcp",
        ])
          yield* expectDiscovery(edge, path);
        expect(
          (yield* rawRequest(`${edge}/.well-known/oauth-protected-resource/${unknown}/mcp`)).status,
        ).toBe(404);
        const issuer = yield* rawRequest(`${edge}/.well-known/oauth-authorization-server/api/auth`);
        expect(issuer.status).toBe(200);
        expect(JSON.parse(issuer.text)).toMatchObject({ issuer: `${edge}/api/auth` });

        // An AuthKit token, and no token at all, get the URL's own challenge: the client signs in
        // to v2 there.
        for (const bearer of [authKitToken(), undefined]) {
          const refused = yield* initializeAt(`${edge}/${moved.slug}/mcp`, bearer);
          expect(refused.status).toBe(401);
          expect(refused.challenge).toBe(challengeFor(edge, `/${moved.slug}/mcp`));
        }
        const native = yield* initializeAt(
          `${edge}/${moved.slug}/mcp?elicitation_mode=native`,
          authKitToken(),
        );
        expect(native.challenge).toBe(challengeFor(edge, `/${moved.slug}/mcp`, "native"));
        // An unknown slug names nothing to sign in to.
        const nothing = yield* initializeAt(`${edge}/${unknown}/mcp`, authKitToken());
        expect(nothing.status).toBe(404);
        expect(nothing.challenge).toBeNull();

        // The owner signs in for the v1 slug URL. Its v2 slug differs, and another team holds the
        // v1 slug as its v2 slug; the grant is the mapped organization's.
        const signedIn = yield* consentTo(actors.owner, `${edge}/${moved.slug}/mcp`);
        expect(signedIn.status).toBe(200);
        const token = yield* signedIn.tokens;
        const reached = yield* whoami(edge, token);
        expect(reached.organization).toEqual({ id: organization.id, slug: organization.slug });
        expect(reached.access.kind).toBe("all");
        for (const path of [
          `/${moved.slug}/mcp`,
          `/${moved.id}/mcp`,
          `/${merged.slug}/mcp`,
          "/mcp",
        ]) {
          const client = yield* mcp.connect(token, `legacy-${path.replaceAll("/", "-")}`, {
            origin: edge,
            path,
          });
          expect(yield* listTools(client), path).toContain("execute");
        }
        // The grant works on v2's own MCP URL too.
        const own = yield* mcp.connect(token, "legacy-grant-on-mcp", { origin: mcpOrigin });
        expect(yield* listTools(own)).toContain("execute");

        // A v1 organization that moved to an organization the owner does not belong to: v2
        // refuses the sign-in, and the owner's own grant is for another organization. The client
        // reads its discovery first, as clients do.
        yield* expectDiscovery(edge, `/${elsewhere.slug}/mcp`);
        const outsider = yield* consentTo(actors.owner, `${edge}/${elsewhere.slug}/mcp`);
        expect(outsider.status).toBe(403);
        const mismatch = yield* initializeAt(
          `${edge}/${elsewhere.slug}/mcp`,
          Redacted.value(token),
        );
        expect(mismatch.status).toBe(403);
        expect(mismatch.text).toContain("names a different organization");
        // A full-account key names no organization on bare `/mcp`, and is not a member of the
        // other team's.
        const unpinned = yield* personalToken(actors.owner);
        const noOrganization = yield* initializeAt(`${edge}/mcp`, Redacted.value(unpinned));
        expect(noOrganization.status).toBe(403);
        expect(noOrganization.text).toContain("does not name an organization");
        const notMember = yield* initializeAt(
          `${edge}/${elsewhere.slug}/mcp`,
          Redacted.value(unpinned),
        );
        expect(notMember.status).toBe(403);
        expect(notMember.text).toContain("is not a member of the organization");
        // The same key on the slug URL works there, for the organization the slug names.
        const keyed = yield* mcp.connect(unpinned, "legacy-key", {
          origin: edge,
          path: `/${moved.slug}/mcp`,
        });
        expect(yield* listTools(keyed)).toContain("execute");
        // An unknown slug's sign-in is refused before consent: it is no resource.
        const unknownSignIn = yield* consentTo(actors.owner, `${edge}/${unknown}/mcp`);
        expect(unknownSignIn.refused).toBe("invalid_target");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.v1ShutdownToolkitUrls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          mcp = yield* McpClient,
          target = yield* Target;
        const { edge } = targetHosts(target);
        const organization = actors.organization;
        const moved = yield* movedV1Organization(organization.id);
        const owner = yield* userOf(actors.owner);
        // The owner's copy of a v1 toolkit: a connection that selects no app.
        const created = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${organization.id}/mcp-connections`,
          { id: randomUUID(), name: "v1 toolkit copy", apps: [] },
        );
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const copy = (yield* body(Schema.Struct({ id: Schema.String }), created)).id;
        const toolkit = v1Slug("toolkit");
        yield* toolkitCopy({ v1Organization: moved.id, toolkit, user: owner, connection: copy });
        const url = `/${moved.slug}/mcp/toolkits/${toolkit}`;

        for (const path of [
          url,
          `/${moved.id}/mcp/toolkits/${toolkit}`,
          `/mcp/toolkits/${toolkit}`,
        ])
          yield* expectDiscovery(edge, path);
        expect(
          (yield* rawRequest(
            `${edge}/.well-known/oauth-protected-resource/${moved.slug}/mcp/toolkits/${v1Slug("none")}`,
          )).status,
        ).toBe(404);
        const challenged = yield* initializeAt(`${edge}${url}`, authKitToken());
        expect(challenged.status).toBe(401);
        expect(challenged.challenge).toBe(challengeFor(edge, url));

        // Signing in for the toolkit URL binds the grant to the owner's own copy.
        const signedIn = yield* consentTo(actors.owner, `${edge}${url}`);
        expect(signedIn.status).toBe(200);
        const token = yield* signedIn.tokens;
        expect((yield* whoami(edge, token)).access).toEqual({ kind: "connection", id: copy });
        const client = yield* mcp.connect(token, "legacy-toolkit", { origin: edge, path: url });
        expect(yield* listTools(client)).toContain("execute");
        expect(yield* searchable(client)).toBe(0);

        // Without the organization in the URL, the person chooses it and the copy is theirs there.
        const bare = yield* consentTo(actors.owner, `${edge}/mcp/toolkits/${toolkit}`, {
          "x-executor-organization": organization.id,
        });
        expect(bare.status).toBe(200);
        expect((yield* whoami(edge, yield* bare.tokens)).access).toEqual({
          kind: "connection",
          id: copy,
        });

        // A member without a copy cannot sign in for the toolkit, nor use it with a key.
        expect((yield* consentTo(actors.member, `${edge}${url}`)).status).toBe(403);
        const memberKey = yield* personalToken(actors.member, organization.id);
        const noCopy = yield* initializeAt(`${edge}${url}`, Redacted.value(memberKey));
        expect(noCopy.status).toBe(403);
        expect(noCopy.text).toContain("names no toolkit of this account's");

        // The owner's key on the toolkit URL is narrowed to their copy; on the organization's URL
        // it keeps its full access.
        const ownerKey = yield* personalToken(actors.owner, organization.id);
        const narrowed = yield* mcp.connect(ownerKey, "legacy-toolkit-key", {
          origin: edge,
          path: url,
        });
        expect(yield* searchable(narrowed)).toBe(0);
        const full = yield* mcp.connect(ownerKey, "legacy-organization-key", {
          origin: edge,
          path: `/${moved.slug}/mcp`,
        });
        expect(yield* searchable(full)).toBeGreaterThan(0);

        // A grant for the organization's URL is not the toolkit's: the client signs in for it.
        yield* expectDiscovery(edge, `/${moved.slug}/mcp`);
        const organizationGrant = yield* consentTo(actors.owner, `${edge}/${moved.slug}/mcp`);
        const other = yield* initializeAt(
          `${edge}${url}`,
          Redacted.value(yield* organizationGrant.tokens),
        );
        expect(other.status).toBe(401);
        expect(other.challenge).toBe(challengeFor(edge, url));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.v1ShutdownSdkSignIn.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          target = yield* Target;
        const { edge, browser } = targetHosts(target);
        const moved = yield* movedV1Organization(actors.organization.id);
        type Provider = NonNullable<
          NonNullable<
            ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
          >["authProvider"]
        >;
        // The client holds what AuthKit gave it, stamped by the SDK with AuthKit's issuer: its
        // registration there and its tokens.
        const authKit = "https://signin.example.test";
        let registered: Awaited<ReturnType<Provider["clientInformation"]>> = {
          client_id: "client_SYNTHETIC_AUTHKIT",
          issuer: authKit,
        };
        let tokens: Awaited<ReturnType<Provider["tokens"]>> = {
          access_token: authKitToken(),
          refresh_token: randomBytes(24).toString("base64url"),
          token_type: "Bearer",
          issuer: authKit,
        };
        let verifier = "";
        let authorization: URL | undefined;
        let authorizations = 0;
        const redirectUrl = "http://127.0.0.1:9/callback";
        const provider: Provider = {
          redirectUrl,
          clientMetadata: {
            client_name: "v1 client",
            redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
          clientInformation: () => registered,
          saveClientInformation: (information) => void (registered = information),
          tokens: () => tokens,
          saveTokens: (saved) => void (tokens = saved),
          redirectToAuthorization: (url) => {
            authorizations += 1;
            authorization = url;
          },
          saveCodeVerifier: (saved) => void (verifier = saved),
          codeVerifier: () => verifier,
          // As real clients do, so the SDK can drop credentials a server refuses.
          invalidateCredentials: (scope) => {
            if (scope === "all" || scope === "client") registered = undefined;
            if (scope === "all" || scope === "tokens") tokens = undefined;
          },
        };
        const serverUrl = new URL(`${edge}/${moved.slug}/mcp`);
        const transport = () => {
          const created = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
          const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = created;
          return { created, compatible };
        };
        // Refused, the client rediscovers the URL's authorization server and asks to sign in
        // there, once, rather than refreshing with AuthKit.
        const signIn = transport();
        const refused = yield* driver("connect with AuthKit's token", () =>
          new Client({ name: "v1 client", version: "1" }).connect(signIn.compatible),
        ).pipe(Effect.flip);
        expect(refused._tag).toBe("DriverFailed");
        if (authorization === undefined) return yield* Effect.die("No authorization request");
        expect(authorizations).toBe(1);
        expect(`${authorization.origin}${authorization.pathname}`).toBe(
          `${browser}/api/auth/oauth2/authorize`,
        );
        expect(authorization.searchParams.get("resource")).toBe(`${edge}/${moved.slug}/mcp`);
        expect(registered?.client_id).not.toBe("client_SYNTHETIC_AUTHKIT");

        // The owner approves; the URL names the organization, so the page sends none.
        const opened = yield* api.request(
          actors.owner,
          "GET",
          `${authorization.pathname}${authorization.search}`,
          undefined,
          { accept: "application/json" },
        );
        expect(opened.status).toBe(200);
        const page = new URL(
          (yield* body(Schema.Struct({ url: Schema.String }), opened)).url,
          browser,
        );
        const consent = yield* api.request(actors.owner, "POST", "/api/auth/oauth2/consent", {
          accept: true,
          oauth_query: page.search.slice(1),
        });
        expect(consent.status, JSON.stringify(consent.body)).toBe(200);
        const code = new URL(
          (yield* body(Schema.Struct({ url: Schema.String }), consent)).url,
        ).searchParams.get("code");
        if (code === null) return yield* Effect.die("No authorization code");
        yield* driver("exchange the code", () => signIn.created.finishAuth(code));

        const client = new Client({ name: "v1 client", version: "1" });
        yield* Effect.acquireRelease(
          driver("connect MCP after signing in", () => client.connect(transport().compatible)),
          () => driver("close MCP", () => client.close()).pipe(Effect.orDie),
        );
        const listed = yield* driver("list tools", () => client.listTools());
        expect(listed.tools.map((tool) => tool.name)).toContain("execute");
        expect(authorizations).toBe(1);
      }),
    ),
  );

  it.effect(scenarios.v1ShutdownConsentPage.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          mcp = yield* McpClient,
          oauth = yield* McpOAuth,
          target = yield* Target;
        const { edge } = targetHosts(target);
        // Codex and Claude Code send the person to the consent page in their browser. Its
        // document carries the edge as the legacy MCP origin, and the page must keep it once it
        // hydrates, or it cannot load a request for one of v1's URLs.
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeAt("mcp", edge);
        expect(grant.resource).toBe(`${edge}/mcp`);
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "legacy-consent-page",
          { origin: edge, path: "/mcp" },
        );
        expect(yield* listTools(client)).toContain("execute");
      }).pipe(Effect.provide(Layer.merge(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.v1ShutdownEdgePages.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          target = yield* Target;
        const { edge, browser, api: apiOrigin } = targetHosts(target);
        const moved = yield* movedV1Organization(actors.organization.id);
        const bytes = (path: string) =>
          driver(`GET ${path}`, (signal) =>
            fetch(`${edge}${path}`, { redirect: "manual", signal }).then((response) =>
              response.arrayBuffer().then((buffer) => ({
                status: response.status,
                sha256: createHash("sha256").update(Buffer.from(buffer)).digest("hex"),
              })),
            ),
          );

        // v1's Google OAuth verification names its terms, privacy policy and Google OAuth page on
        // executor.sh. The site's own pages of the same name answer them, not copies of v1's.
        for (const [path, text] of [
          ["/terms", "Terms of Service"],
          ["/privacy", "Privacy Policy"],
          ["/google-oauth", "googleapis.com/auth/calendar"],
        ] as const) {
          const page = yield* rawRequest(`${edge}${path}`, { headers: { accept: "text/html" } });
          expect(page.status, path).toBe(200);
          expect(page.text, path).toContain(text);
        }
        // v1's favicon, which the site serves byte for byte.
        expect(yield* bytes("/favicon-192.png")).toEqual({
          status: 200,
          sha256: "e5fd761a0cd80d51d451cc06e9e6d0236dcc39317248a13ac5db5fcf4d52d0ca",
        });

        // v1's OAuth client ID metadata documents, as v1 generated them for its host.
        const web = (name: string) =>
          `{"client_id":"${edge}/api/oauth/client-id-metadata/${name}.json","client_name":"Executor","client_uri":"${edge}","redirect_uris":["${edge}/api/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"web"}`;
        for (const name of ["default", "tb", moved.slug]) {
          const document = yield* rawRequest(`${edge}/api/oauth/client-id-metadata/${name}.json`);
          expect(document.status, name).toBe(200);
          expect(document.text, name).toBe(web(name));
        }
        const local = yield* rawRequest(`${edge}/api/oauth/client-id-metadata/local.json`);
        expect(local.text).toBe(
          `{"client_id":"${edge}/api/oauth/client-id-metadata/local.json","client_name":"Executor Local","client_uri":"${edge}","redirect_uris":["http://127.0.0.1/api/oauth/callback","http://localhost/api/oauth/callback","http://[::1]/api/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"native"}`,
        );

        // A v1 dashboard opens the organization it moved to in v2, by its v2 slug.
        for (const path of [`/${moved.slug}`, `/${moved.slug}/integrations`]) {
          const dashboard = yield* rawRequest(`${edge}${path}`);
          expect(dashboard.status, path).toBe(302);
          expect(dashboard.location, path).toBe(`${browser}/org/${actors.organization.slug}`);
        }
        expect((yield* rawRequest(`${edge}/${v1Slug("unknown")}`)).status).toBe(404);

        // v1's sign-in paths open v2's sign-in, and sign-up v2's sign-up.
        for (const path of [
          "/login",
          "/api/auth/login",
          "/api/auth/callback?code=synthetic",
          "/api/auth/logout",
          "/api/auth/me",
        ]) {
          const signIn = yield* rawRequest(`${edge}${path}`);
          expect(signIn.status, path).toBe(302);
          expect(signIn.location, path).toBe(`${browser}/login`);
        }
        const signUp = yield* rawRequest(`${edge}/sign-up`);
        expect(signUp.location).toBe(`${browser}/login?mode=signup`);
        // v2 dashboard links and slashed site pages redirect as v1's edge did.
        const dashboardLink = yield* rawRequest(`${edge}/org/${actors.organization.slug}/apps?x=1`);
        expect(dashboardLink.status).toBe(308);
        expect(dashboardLink.location).toBe(`${browser}/org/${actors.organization.slug}/apps?x=1`);
        const slashed = yield* rawRequest(`${edge}/pricing/?ref=v1`);
        expect(slashed.status).toBe(308);
        expect(slashed.location).toBe("/pricing?ref=v1");

        // A connected-account sign-in v1 started cannot finish; one v2 started is v2's.
        const v1Callback = yield* rawRequest(
          `${edge}/api/oauth/callback?code=synthetic&state=${randomBytes(16).toString("base64url")}`,
        );
        expect(v1Callback.status).toBe(410);
        expect(v1Callback.contentType).toContain("text/html");
        expect(v1Callback.text).toContain("This sign-in started in Executor v1");
        const v2Callback = yield* rawRequest(
          `${edge}/api/oauth/callback?code=synthetic&state=x2.${randomBytes(16).toString("base64url")}`,
        );
        expect(v2Callback.status).not.toBe(410);

        // The rest of v1's REST API is gone, for every method.
        for (const [method, path] of [
          ["GET", "/api/organizations"],
          ["POST", "/api/integrations"],
          ["DELETE", "/api/connections/synthetic"],
        ] as const) {
          const gone = yield* rawRequest(`${edge}${path}`, { method });
          expect(gone.status, `${method} ${path}`).toBe(410);
          expect(JSON.parse(gone.text), path).toEqual({
            error: "gone",
            message: `Executor v1's API has shut down. Use Executor's API at ${apiOrigin}/api.`,
            api: `${apiOrigin}/api`,
          });
        }

        // The site is unchanged.
        expect((yield* rawRequest(`${edge}/`)).status).toBe(200);
        expect((yield* rawRequest(`${edge}/pricing`)).status).toBe(200);
      }),
    ),
  );
});

const importServices = Layer.mergeAll(Onboarding.layer, Emulators.layer, McpClient.layer);

/** Run the v1 URL backfill against the managed Cloud's and the synthetic v1's databases. */
const backfill = (organization: string, apply: boolean) =>
  Effect.gen(function* () {
    const target = yield* Target,
      fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const database = (file: string) =>
      fs.readFileString(`${target.directory}/${file}`).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ database: Schema.String })),
          ),
        ),
        Effect.map((found) => found.database),
      );
    const output = yield* processes.string(
      ChildProcess.make(
        "node",
        [
          "apps/hosted/cloud/scripts/v1-legacy-urls.ts",
          "--organization",
          organization,
          ...(apply ? ["--apply"] : []),
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            DATABASE_URL: yield* database("sso-database.json"),
            V1_DATABASE_URL: yield* database("v1-database.json"),
          },
          extendEnv: false,
        },
      ),
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          mode: Schema.String,
          cutOver: Schema.Number,
          written: Schema.Number,
          refused: Schema.Array(Schema.Unknown),
        }),
      ),
    )(output);
  });

const Count = Schema.Array(Schema.Array(Schema.Struct({ count: Schema.Number })));

layer(TestLive, { excludeTestServices: true })("Cloud after v1's shutdown, moved", (it) => {
  it.effect(
    scenarios.v1ShutdownApiKeyCapture.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const emulators = yield* Emulators,
            operator = yield* v1ImportOperator,
            mcp = yield* McpClient,
            target = yield* Target;
          const { edge, mcp: mcpOrigin, api: apiOrigin } = targetHosts(target);
          // A v1 workspace moved by the operator's import, which records its v1 URLs.
          const email = `shutdown-${randomUUID().slice(0, 8)}@example.test`;
          const workspace = yield* emulators.v1Workspace([email]);
          const slug = v1Slug("moved");
          yield* writeRows("v1-database.json", [
            {
              sql: "insert into organizations (id, name, slug) values ($1, 'Synthetic workspace', $2)",
              params: [workspace.organization, slug],
            },
          ]);
          yield* allowV1Import(workspace.organization);
          const run = v1RunId("shutdown");
          const started = yield* operator.start({
            mode: "import",
            runId: run,
            organizations: [workspace.organization],
          });
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          const report = yield* operator.waitForReport(run, workspace.organization);
          expect(report.status, report.reason ?? "").toBe("imported");
          expect(report.cutover).toBe(true);
          yield* expectDiscovery(edge, `/${slug}/mcp`);
          yield* expectDiscovery(edge, `/${workspace.organization}/mcp`);

          const counts = (hash: string, id: string) =>
            writeRows("sso-database.json", [
              { sql: "select count(*)::int as count from apikey where key = $1", params: [hash] },
              {
                sql: "select count(*)::int as count from private_v1_captured_api_key where workos_key_id = $1",
                params: [id],
              },
            ]).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Count)),
              Effect.map(([stored, recorded]) => [stored?.[0]?.count, recorded?.[0]?.count]),
            );
          const listAt = (key: string, label: string, origin: string, path: string) =>
            Effect.gen(function* () {
              const client = yield* mcp.connect(Redacted.make(key), label, { origin, path });
              return yield* listTools(client);
            });

          // The member's WorkOS key, made in v1 and never seen by v2: WorkOS vouches for it on its
          // first use, and v2 stores it as the member's own key, pinned to the moved organization.
          const key = yield* emulators.v1ApiKey(workspace.user, workspace.organization);
          expect(yield* counts(keyHash(key.value), key.id)).toEqual([0, 0]);
          expect(yield* listAt(key.value, "first-use", edge, `/${slug}/mcp`)).toContain("execute");
          expect(yield* counts(keyHash(key.value), key.id)).toEqual([1, 1]);
          const stored = yield* writeRows("sso-database.json", [
            {
              sql: `select prefix, name, metadata::jsonb ->> 'organization' as organization,
              "expiresAt" is null as lasting, enabled from apikey where key = $1`,
              params: [keyHash(key.value)],
            },
          ]);
          expect(stored[0]?.[0]).toEqual({
            prefix: "sk_",
            name: "Imported from Executor v1",
            organization: report.v2Organization?.id,
            lasting: true,
            enabled: true,
          });

          // From now on WorkOS refuses every validation, and the key works natively on v1's URLs,
          // v2's own MCP and v2's API.
          const outage = yield* emulators.failV1KeyValidations({ status: 503, times: 1000 });
          yield* Effect.addFinalizer(() => emulators.clearWorkosFault(outage).pipe(Effect.ignore));
          const native: ReadonlyArray<readonly [string, string, string]> = [
            ["slug", edge, `/${slug}/mcp`],
            ["id", edge, `/${workspace.organization}/mcp`],
            ["bare", edge, "/mcp"],
            ["mcp host", mcpOrigin, "/mcp"],
          ];
          for (const [label, origin, path] of native)
            expect(yield* listAt(key.value, `native-${label}`, origin, path), label).toContain(
              "execute",
            );
          const viaApi = yield* rawRequest(`${apiOrigin}/api/context`, {
            headers: { authorization: `Bearer ${key.value}` },
          });
          expect(viaApi.status, viaApi.text).toBe(200);
          expect(
            (yield* emulators.workosFaults).get(outage),
            "a stored key never asks WorkOS again",
          ).toBe(1000);

          // While WorkOS cannot answer, a WorkOS key v2 does not hold is an outage to retry.
          const unseen = yield* emulators.v1ApiKey(workspace.user, workspace.organization);
          const unanswered = yield* initializeAt(`${edge}/${slug}/mcp`, unseen.value);
          expect(unanswered.status).toBe(503);
          expect(yield* counts(keyHash(unseen.value), unseen.id)).toEqual([0, 0]);
          yield* emulators.clearWorkosFault(outage);
          expect(yield* listAt(unseen.value, "after-outage", edge, `/${slug}/mcp`)).toContain(
            "execute",
          );

          // A key WorkOS does not know is refused, and is not asked about again soon: a second use
          // leaves a fault armed for it unspent.
          const unknown = `sk_test_${randomBytes(24).toString("base64url")}`;
          const refused = yield* initializeAt(`${edge}/${slug}/mcp`, unknown);
          expect(refused.status).toBe(401);
          expect(refused.challenge).toBe(challengeFor(edge, `/${slug}/mcp`));
          const watch = yield* emulators.failV1KeyValidations({ status: 503, times: 1 });
          expect((yield* initializeAt(`${edge}/${slug}/mcp`, unknown)).status).toBe(401);
          expect((yield* emulators.workosFaults).get(watch)).toBe(1);
          yield* emulators.clearWorkosFault(watch);

          // A key of an organization that did not move is valid in WorkOS but not stored.
          const elsewhere = yield* emulators.v1Workspace([
            `unmoved-${randomUUID().slice(0, 8)}@example.test`,
          ]);
          const unmoved = yield* emulators.v1ApiKey(elsewhere.user, elsewhere.organization);
          expect((yield* initializeAt(`${edge}/mcp`, unmoved.value)).status).toBe(401);
          expect(yield* counts(keyHash(unmoved.value), unmoved.id)).toEqual([0, 0]);

          // A key its owner deleted in v2 is never stored again, though WorkOS still vouches for it.
          yield* writeRows("sso-database.json", [
            { sql: "delete from apikey where key = $1", params: [keyHash(key.value)] },
          ]);
          expect((yield* initializeAt(`${edge}/${slug}/mcp`, key.value)).status).toBe(401);
          expect(yield* counts(keyHash(key.value), key.id)).toEqual([0, 1]);

          // The backfill writes the organization's v1 URLs again from the import's records and v1.
          yield* writeRows("sso-database.json", [
            {
              sql: "delete from private_v1_legacy_org where v1_org_id = $1",
              params: [workspace.organization],
            },
          ]);
          const gone = yield* rawRequest(
            `${edge}/.well-known/oauth-protected-resource/${slug}/mcp`,
          );
          expect(gone.status).toBe(404);
          const dryRun = yield* backfill(workspace.organization, false);
          expect(dryRun).toMatchObject({ mode: "dry run", cutOver: 1, written: 1, refused: [] });
          expect(
            (yield* rawRequest(`${edge}/.well-known/oauth-protected-resource/${slug}/mcp`)).status,
            "the dry run writes nothing",
          ).toBe(404);
          const applied = yield* backfill(workspace.organization, true);
          expect(applied).toMatchObject({ mode: "apply", cutOver: 1, written: 1, refused: [] });
          yield* expectDiscovery(edge, `/${slug}/mcp`);
        }).pipe(Effect.provide(importServices)),
      ),
    // The import, then many requests on v1's URLs and v2's.
    { timeout: 180_000 },
  );
});
