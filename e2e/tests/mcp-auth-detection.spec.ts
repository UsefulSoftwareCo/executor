/**
 * Quick add decides how to connect each remote MCP server from what the server answers without
 * credentials, and says which signals decided it. Each server emulates a real service's pattern.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Inventory, Resource } from "../support/contracts.ts";
import { mcpAuthServer, type McpAuthPattern } from "../support/mcp-auth-patterns.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

const Imported = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Setup = Schema.Struct({
  mode: Schema.Literals(["automatic", "saved", "client-required"]),
  scopes: Schema.Array(Schema.String),
});
const Signal = Schema.Struct({
  _tag: Schema.String,
  method: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  media: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
});
const Rejected = Schema.Struct({
  _tag: Schema.Literal("CatalogImportFailed"),
  code: Schema.String,
  reason: Schema.String,
  detection: Schema.Struct({
    _tag: Schema.String,
    reason: Schema.optional(Schema.String),
    scheme: Schema.optional(Schema.String),
    signals: Schema.Array(Signal),
  }),
});
const SetupFailed = Schema.Struct({
  _tag: Schema.Literal("OAuthSetupFailed"),
  reason: Schema.String,
  cause: Schema.optional(
    Schema.Struct({ stage: Schema.String, field: Schema.optional(Schema.String) }),
  ),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });

/** Import one emulated server through the hosted Connect a service API. */
const importer = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const attempt = (pattern: McpAuthPattern) =>
    Effect.gen(function* () {
      const server = yield* mcpAuthServer(pattern);
      const name = `${pattern} ${randomUUID().slice(0, 8)}`;
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
        source: { kind: "mcp", name, url: server.url },
      });
      return { server, name, response };
    });
  const imported = (pattern: McpAuthPattern) =>
    Effect.gen(function* () {
      const { server, response } = yield* attempt(pattern);
      expect(response.status, `${pattern}: ${JSON.stringify(response.body)}`).toBe(200);
      const app = yield* body(Imported, response);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return { server, app };
    });
  const rejected = (pattern: McpAuthPattern) =>
    Effect.gen(function* () {
      const { server, name, response } = yield* attempt(pattern);
      expect(response.status, `${pattern}: ${JSON.stringify(response.body)}`).toBe(422);
      // Reasons and signals never repeat the server's address or its responses.
      expect(JSON.stringify(response.body)).not.toContain(server.origin);
      const inventory = yield* body(
        Inventory,
        yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
      );
      expect(inventory.apps.map((app) => app.name)).not.toContain(name);
      return yield* body(Rejected, response);
    });
  const setupResponse = (provider: string) =>
    api.request(actors.owner, "GET", `${prefix}/providers/${provider}/oauth/oauth/setup`);
  const setup = (provider: string) =>
    setupResponse(provider).pipe(Effect.flatMap((response) => body(Setup, response)));
  /** Deploy an app whose provider discovers OAuth from `url`, as an author would write it. */
  const discovering = (url: string) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Discovered OAuth ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, router } from "apps";
const service=defineProvider({name:"Discovered service",auth:{oauth:oauth2({discover:${JSON.stringify(url)}})}});
export default defineApp({accounts:{service}},async()=>({tools: router({})}));`,
          },
          appsManifest,
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(Imported, response);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      const service = app.requirements.accounts.service;
      if (service === undefined) return yield* Effect.die("The app declares no account");
      return service.provider;
    });
  const startOAuth = (appId: string, client?: { readonly clientId: string }) =>
    Effect.gen(function* () {
      const profile = yield* createProfile(actors.owner, `${prefix}/apps/${appId}`);
      const connection = yield* body(
        Resource,
        yield* api.request(actors.owner, "POST", `${prefix}/apps/${appId}/connections`, {
          requirement: "service",
          profile: profile.id,
        }),
      );
      return yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/start`,
        {
          method: "oauth",
          label: "Synthetic account",
          ...(client === undefined ? {} : { client }),
        },
      );
    });
  return { prefix, imported, rejected, setup, setupResponse, discovering, startOAuth };
});

layer(HostedLive, { excludeTestServices: true })("MCP auth detection", (it) => {
  it.effect(scenarios.mcpAuthDetectionPublic.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { prefix, imported } = yield* importer;
        const source = (appId: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/apps/${appId}/source`)
            .pipe(Effect.flatMap((response) => body(Source, response)));

        // A server that works anonymously needs no account and gets no provider.
        const open = yield* imported("anonymous");
        expect(open.app.requirements.accounts).toEqual({});
        expect((yield* source(open.app.id)).files.map((file) => file.path)).not.toContain(
          "provider.ts",
        );

        // Exa answers anonymously over SSE and also publishes OAuth metadata: it is added without
        // an account, and its discovered OAuth provider is kept so accounts can be added later.
        const exa = yield* imported("anonymous-oauth");
        expect(exa.app.requirements.accounts).toEqual({});
        const files = (yield* source(exa.app.id)).files;
        const provider = files.find((file) => file.path === "provider.ts")?.content;
        expect(provider, "The OAuth the server offers is recorded").toContain(
          `"discover": "${exa.server.url}"`,
        );
        expect(files.find((file) => file.path === "index.ts")?.content).toContain(
          "also offers OAuth sign-in",
        );
      }),
    ),
  );

  it.effect(scenarios.mcpAuthDetectionOAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { imported, setup, startOAuth } = yield* importer;

        // Dynamic registration: Executor registers its own client when the account connects.
        const dcr = yield* imported("oauth-dcr");
        const service = dcr.app.requirements.accounts.service;
        if (service === undefined) return yield* Effect.die("The OAuth app declares no account");
        expect((yield* setup(service.provider)).mode).toBe("automatic");
        const started = yield* startOAuth(dcr.app.id);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        expect(yield* dcr.server.registrations).toBe(1);

        // GitHub's authorization server registers no clients: the user supplies one.
        const manual = yield* imported("oauth-manual");
        const manualService = manual.app.requirements.accounts.service;
        if (manualService === undefined)
          return yield* Effect.die("The OAuth app declares no account");
        expect((yield* setup(manualService.provider)).mode).toBe("client-required");
        const supplied = yield* startOAuth(manual.app.id, { clientId: "user-registered-client" });
        expect(supplied.status, JSON.stringify(supplied.body)).toBe(200);
        expect(
          new URL((yield* body(SignIn, supplied)).authorizationUrl).searchParams.get("client_id"),
        ).toBe("user-registered-client");

        // The only metadata is the document the WWW-Authenticate challenge names.
        const challenged = yield* imported("challenge-only");
        expect(Object.keys(challenged.app.requirements.accounts)).toEqual(["service"]);

        // Ahrefs lists its scopes as `scopes_provided`; sign-in requests them.
        const ahrefs = yield* imported("scopes-provided");
        const ahrefsService = ahrefs.app.requirements.accounts.service;
        if (ahrefsService === undefined)
          return yield* Effect.die("The OAuth app declares no account");
        expect((yield* setup(ahrefsService.provider)).scopes).toEqual(["apiv3-mcp"]);

        // Fastmail's registration refuses Executor's callback: setup asks for a client instead.
        const fastmail = yield* imported("dcr-rejects-redirect");
        const refused = yield* startOAuth(fastmail.app.id);
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect((yield* body(SetupFailed, refused)).reason).toBe("client_not_approved");

        // Microsoft Entra ID lists no PKCE methods but accepts S256. The server is added, and
        // sign-in still sends an S256 challenge.
        const entraLike = yield* imported("pkce-unadvertised");
        const entraLikeService = entraLike.app.requirements.accounts.service;
        if (entraLikeService === undefined)
          return yield* Effect.die("The OAuth app declares no account");
        expect((yield* setup(entraLikeService.provider)).mode).toBe("automatic");
        const unadvertised = yield* startOAuth(entraLike.app.id);
        expect(unadvertised.status, JSON.stringify(unadvertised.body)).toBe(200);
        const authorize = new URL((yield* body(SignIn, unadvertised)).authorizationUrl);
        expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
      }),
    ),
  );

  it.effect(scenarios.mcpAuthDetectionSetup.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors;
        const { rejected, setupResponse, discovering } = yield* importer;

        // A Bearer challenge with no OAuth anywhere means an API key.
        const keyed = yield* rejected("bearer-key");
        expect(keyed.code).toBe("agent_setup_required");
        expect(keyed.detection).toMatchObject({ _tag: "CredentialsRequired", scheme: "bearer" });
        expect(keyed.detection.signals[0]).toMatchObject({
          _tag: "McpRequest",
          method: "initialize",
          status: 401,
        });
        expect(keyed.detection.signals.map((signal) => signal.location ?? signal._tag)).toEqual([
          "McpRequest",
          "path",
          "root",
          "AuthorizationServerMetadata",
        ]);
        expect(keyed.reason).toContain("HTTP 401 and a Bearer challenge");
        expect(keyed.reason).toContain("add it with your agent");

        // A JSON-RPC error to initialize is reported as such, not as a sign-in requirement.
        const failing = yield* rejected("initialize-fails");
        expect(failing.code).toBe("agent_setup_required");
        expect(failing.detection).toMatchObject({
          _tag: "Undetermined",
          reason: "initialize_error",
        });

        // A firewall's 403 page with no challenge or metadata is a refusal, not an API key.
        const blocked = yield* rejected("refused");
        expect(blocked.code).toBe("agent_setup_required");
        expect(blocked.detection).toMatchObject({ _tag: "Undetermined", reason: "refused" });
        expect(blocked.detection.signals[0]).toMatchObject({ status: 403, media: "html" });
        expect(blocked.reason).toContain("firewall");

        // OAuth that account setup would refuse is not confirmed: this token endpoint accepts
        // only private_key_jwt clients, which setup cannot register or accept.
        const keyOnly = yield* rejected("client-auth-unsupported");
        expect(keyOnly.detection).toMatchObject({ _tag: "Undetermined", reason: "oauth_unusable" });
        expect(keyOnly.detection.signals.at(-1)).toMatchObject({
          _tag: "AuthorizationServerMetadata",
          result: "invalid",
        });
        expect(keyOnly.reason).toContain("cannot be used to prepare sign-in");

        // An authorization server that lists its PKCE methods without S256 cannot take the S256
        // challenge Executor sends. The check does not confirm it, and account setup for an app
        // that discovers it refuses it too.
        const plain = yield* rejected("pkce-plain");
        expect(plain.detection).toMatchObject({ _tag: "Undetermined", reason: "oauth_unusable" });
        expect(plain.detection.signals.at(-1)).toMatchObject({
          _tag: "AuthorizationServerMetadata",
          result: "unsupported",
        });
        expect(plain.reason).toContain("does not support authorization-code sign-in with PKCE");
        const plainServer = yield* mcpAuthServer("pkce-plain");
        const refused = yield* setupResponse(yield* discovering(plainServer.url));
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect(yield* body(SetupFailed, refused)).toMatchObject({
          reason: "unsupported",
          cause: { stage: "discover", field: "code_challenge_methods_supported" },
        });

        // The dashboard shows the reason with the signals that decided it.
        const server = yield* mcpAuthServer("bearer-key");
        yield* browser.login(actors.owner);
        yield* browser.use("Open Connect a service", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/add/custom`),
        );
        yield* browser.use("Name the app", (page) =>
          page.getByLabel("App name", { exact: true }).fill("Keyed service"),
        );
        yield* browser.use("Enter the server URL", (page) =>
          page.getByLabel("MCP server URL", { exact: true }).fill(server.url),
        );
        yield* browser.use("Add the app", (page) =>
          page.getByRole("button", { name: "Add app" }).click(),
        );
        yield* browser.use("The reason names its signals", (page) =>
          page.getByText("HTTP 401 and a Bearer challenge").waitFor(),
        );
        yield* browser.checkpoint("An API-key MCP server explains why it needs agent setup");
      }),
    ),
  );
});
