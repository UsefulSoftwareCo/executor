import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { writeRows } from "../support/cloud-rows.ts";
import { Emulators } from "../support/emulators.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { Execution, consentTo } from "../support/mcp-connections.ts";
import { Target, driver } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { recordMovedV1Organization } from "../support/v1-moved.ts";
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

const userOf = (session: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* body(Identity, yield* api.request(session, "GET", "/api/auth/get-session"))).user
      .id;
  });

const keyHash = (key: string) => createHash("sha256").update(key).digest("base64url");

const v1OrganizationId = () => `org_${randomBytes(13).toString("hex").toUpperCase()}`;
const v1Slug = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

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

const challengeFor = (edge: string, path: string, mode = "model") =>
  `Bearer resource_metadata="${edge}/.well-known/oauth-protected-resource${path}?elicitation_mode=${mode}", scope="mcp offline_access"`;

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

const whoami = (edge: string, bearer: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const response = yield* rawRequest(`${edge}/mcp/whoami`, {
      headers: { authorization: `Bearer ${Redacted.value(bearer)}` },
    });
    expect(response.status, response.text).toBe(200);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Whoami))(response.text);
  });

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
        const held = yield* otherV2Organization(v1Slug("held"));
        const moved = yield* movedV1Organization(organization.id, held.slug);
        const merged = yield* movedV1Organization(organization.id);
        const elsewhere = yield* movedV1Organization(held.id);
        const unknown = v1Slug("unknown");

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
        const nothing = yield* initializeAt(`${edge}/${unknown}/mcp`, authKitToken());
        expect(nothing.status).toBe(404);
        expect(nothing.challenge).toBeNull();

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
        const own = yield* mcp.connect(token, "legacy-grant-on-mcp", { origin: mcpOrigin });
        expect(yield* listTools(own)).toContain("execute");

        yield* expectDiscovery(edge, `/${elsewhere.slug}/mcp`);
        const outsider = yield* consentTo(actors.owner, `${edge}/${elsewhere.slug}/mcp`);
        expect(outsider.status).toBe(403);
        const mismatch = yield* initializeAt(
          `${edge}/${elsewhere.slug}/mcp`,
          Redacted.value(token),
        );
        expect(mismatch.status).toBe(403);
        expect(mismatch.text).toContain("names a different organization");
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
        const keyed = yield* mcp.connect(unpinned, "legacy-key", {
          origin: edge,
          path: `/${moved.slug}/mcp`,
        });
        expect(yield* listTools(keyed)).toContain("execute");
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

        const signedIn = yield* consentTo(actors.owner, `${edge}${url}`);
        expect(signedIn.status).toBe(200);
        const token = yield* signedIn.tokens;
        expect((yield* whoami(edge, token)).access).toEqual({ kind: "connection", id: copy });
        const client = yield* mcp.connect(token, "legacy-toolkit", { origin: edge, path: url });
        expect(yield* listTools(client)).toContain("execute");
        expect(yield* searchable(client)).toBe(0);

        const bare = yield* consentTo(actors.owner, `${edge}/mcp/toolkits/${toolkit}`, {
          "x-executor-organization": organization.id,
        });
        expect(bare.status).toBe(200);
        expect((yield* whoami(edge, yield* bare.tokens)).access).toEqual({
          kind: "connection",
          id: copy,
        });

        expect((yield* consentTo(actors.member, `${edge}${url}`)).status).toBe(403);
        const memberKey = yield* personalToken(actors.member, organization.id);
        const noCopy = yield* initializeAt(`${edge}${url}`, Redacted.value(memberKey));
        expect(noCopy.status).toBe(403);
        expect(noCopy.text).toContain("names no toolkit of this account's");

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

        for (const [path, text] of [
          ["/terms", "Terms of Service"],
          ["/privacy", "Privacy Policy"],
          ["/google-oauth", "googleapis.com/auth/calendar"],
        ] as const) {
          const page = yield* rawRequest(`${edge}${path}`, { headers: { accept: "text/html" } });
          expect(page.status, path).toBe(200);
          expect(page.text, path).toContain(text);
        }
        expect(yield* bytes("/favicon-192.png")).toEqual({
          status: 200,
          sha256: "e5fd761a0cd80d51d451cc06e9e6d0236dcc39317248a13ac5db5fcf4d52d0ca",
        });

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

        for (const path of [`/${moved.slug}`, `/${moved.slug}/integrations`]) {
          const dashboard = yield* rawRequest(`${edge}${path}`);
          expect(dashboard.status, path).toBe(302);
          expect(dashboard.location, path).toBe(`${browser}/org/${actors.organization.slug}`);
        }
        expect((yield* rawRequest(`${edge}/${v1Slug("unknown")}`)).status).toBe(404);

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
        const dashboardLink = yield* rawRequest(`${edge}/org/${actors.organization.slug}/apps?x=1`);
        expect(dashboardLink.status).toBe(308);
        expect(dashboardLink.location).toBe(`${browser}/org/${actors.organization.slug}/apps?x=1`);
        const slashed = yield* rawRequest(`${edge}/pricing/?ref=v1`);
        expect(slashed.status).toBe(308);
        expect(slashed.location).toBe("/pricing?ref=v1");

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

        expect((yield* rawRequest(`${edge}/`)).status).toBe(200);
        expect((yield* rawRequest(`${edge}/pricing`)).status).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.v1ShutdownAuthKitHost.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const { authKit, browser, deployment } = targetHosts(target);
        const shutDown = "Executor v1's sign-in has shut down. Sign in to Executor again.";
        const expectJson = (
          response: Effect.Success<ReturnType<typeof rawRequest>>,
          status: number,
          error: string,
          label: string,
        ) => {
          expect(response.status, label).toBe(status);
          expect(response.contentType, label).toContain("application/json");
          expect(response.cacheControl, label).toBe("no-store");
          expect(JSON.parse(response.text), label).toEqual({ error, error_description: shutDown });
        };

        for (const path of [
          "/.well-known/oauth-authorization-server",
          "/.well-known/openid-configuration",
          "/.well-known/oauth-authorization-server/oauth2",
          "/.well-known/openid-configuration/oauth2",
          "/oauth2/.well-known/openid-configuration",
        ]) {
          expectJson(yield* rawRequest(`${authKit}${path}`), 404, "not_found", path);
          expect((yield* rawRequest(`${authKit}${path}`, { method: "HEAD" })).status, path).toBe(
            404,
          );
        }

        const refresh = yield* rawRequest(`${authKit}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: randomBytes(24).toString("base64url"),
            client_id: "client_SYNTHETIC_AUTHKIT",
          }).toString(),
        });
        expectJson(refresh, 400, "invalid_grant", "token");
        expect(refresh.allowOrigin).toBe("*");

        // Revoking a token AuthKit issued succeeds, as RFC 7009 answers an unknown token.
        const revoked = yield* rawRequest(`${authKit}/oauth2/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: randomBytes(24).toString("base64url") }).toString(),
        });
        expect(revoked.status).toBe(200);
        expect(revoked.text).toBe("");

        expectJson(yield* rawRequest(`${authKit}/oauth2/jwks`), 404, "not_found", "jwks");
        expectJson(
          yield* rawRequest(`${authKit}/oauth2/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/callback"] }),
          }),
          410,
          "gone",
          "register",
        );

        const marker = `marker${randomUUID().replaceAll("-", "")}`;
        const authorize = yield* rawRequest(
          `${authKit}/oauth2/authorize?${new URLSearchParams({
            client_id: `client_${marker}`,
            redirect_uri: `http://127.0.0.1:9/${marker}`,
            state: `<script>${marker}</script>`,
            response_type: "code",
          })}`,
          { headers: { accept: "text/html" } },
        );
        expect(authorize.status).toBe(410);
        expect(authorize.contentType).toContain("text/html");
        expect(authorize.cacheControl).toBe("no-store");
        expect(authorize.text).toContain("Executor v1's sign-in has shut down");
        expect(authorize.text).toContain("Clear authentication");
        expect(authorize.text).toContain("claude mcp remove");
        expect(authorize.text).toContain(`<a href="${browser}">Open Executor</a>`);
        expect(authorize.text).not.toContain(marker);
        for (const path of ["/", "/sign-in", "/api/auth/get-session"]) {
          const page = yield* rawRequest(`${authKit}${path}`);
          expect(page.status, path).toBe(410);
          expect(page.text, path).toContain("Executor v1's sign-in has shut down");
        }

        for (const [method, path] of [
          ["POST", "/token"],
          ["POST", "/mcp"],
          ["POST", "/oauth2/authorize"],
          ["DELETE", "/oauth2/token"],
          ["PUT", "/.well-known/openid-configuration"],
        ] as const) {
          expectJson(
            yield* rawRequest(`${authKit}${path}`, {
              method,
              headers: { "content-type": "application/json" },
              body: "{}",
            }),
            410,
            "gone",
            `${method} ${path}`,
          );
        }

        const issuer = yield* rawRequest(`${deployment}/.well-known/oauth-authorization-server`);
        expect(issuer.status).toBe(200);
        expect(JSON.parse(issuer.text)).toHaveProperty("token_endpoint");
      }),
    ),
  );
});

const Count = Schema.Array(Schema.Array(Schema.Struct({ count: Schema.Number })));

layer(HostedLive, { excludeTestServices: true })("Cloud after v1's shutdown, moved", (it) => {
  it.effect(
    scenarios.v1ShutdownApiKeyCapture.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors,
            emulators = yield* Emulators,
            mcp = yield* McpClient,
            target = yield* Target;
          const { edge, mcp: mcpOrigin, api: apiOrigin } = targetHosts(target);
          const email = `shutdown-${randomUUID().slice(0, 8)}@example.test`;
          const workspace = yield* emulators.v1Workspace([email]);
          const slug = v1Slug("moved");
          const owner = yield* userOf(actors.owner);
          yield* writeRows("sso-database.json", [
            {
              sql: "insert into private_v1_legacy_org (v1_org_id, v1_slug, v2_org_id) values ($1, $2, $3)",
              params: [workspace.organization, slug, actors.organization.id],
            },
          ]);
          yield* recordMovedV1Organization({
            v1Organization: workspace.organization,
            v2Organization: actors.organization.id,
            users: [{ v1: workspace.user, v2: owner }],
          });
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
            organization: actors.organization.id,
            lasting: true,
            enabled: true,
          });

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

          const unseen = yield* emulators.v1ApiKey(workspace.user, workspace.organization);
          const unanswered = yield* initializeAt(`${edge}/${slug}/mcp`, unseen.value);
          expect(unanswered.status).toBe(503);
          expect(yield* counts(keyHash(unseen.value), unseen.id)).toEqual([0, 0]);
          yield* emulators.clearWorkosFault(outage);
          expect(yield* listAt(unseen.value, "after-outage", edge, `/${slug}/mcp`)).toContain(
            "execute",
          );

          const unknown = `sk_test_${randomBytes(24).toString("base64url")}`;
          const refused = yield* initializeAt(`${edge}/${slug}/mcp`, unknown);
          expect(refused.status).toBe(401);
          expect(refused.challenge).toBe(challengeFor(edge, `/${slug}/mcp`));
          const watch = yield* emulators.failV1KeyValidations({ status: 503, times: 1 });
          expect((yield* initializeAt(`${edge}/${slug}/mcp`, unknown)).status).toBe(401);
          expect((yield* emulators.workosFaults).get(watch)).toBe(1);
          yield* emulators.clearWorkosFault(watch);

          const elsewhere = yield* emulators.v1Workspace([
            `unmoved-${randomUUID().slice(0, 8)}@example.test`,
          ]);
          const unmoved = yield* emulators.v1ApiKey(elsewhere.user, elsewhere.organization);
          expect((yield* initializeAt(`${edge}/mcp`, unmoved.value)).status).toBe(401);
          expect(yield* counts(keyHash(unmoved.value), unmoved.id)).toEqual([0, 0]);

          yield* writeRows("sso-database.json", [
            { sql: "delete from apikey where key = $1", params: [keyHash(key.value)] },
          ]);
          expect((yield* initializeAt(`${edge}/${slug}/mcp`, key.value)).status).toBe(401);
          expect(yield* counts(keyHash(key.value), key.id)).toEqual([0, 1]);
        }).pipe(Effect.provide(Layer.merge(Emulators.layer, McpClient.layer))),
      ),
    { timeout: 180_000 },
  );
});
