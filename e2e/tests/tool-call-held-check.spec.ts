/**
 * A read-only rule decides a tool call by the tool's live metadata, so its check evaluates the app
 * before the call runs, for as long as the app takes. The call runs the profile and credentials
 * saved after that check, not those read before it: a profile disabled or an account reconnected
 * while the check waits takes effect on that call. The app's listing reads a loopback resource
 * that holds the check until the scenario has changed the saved state.
 *
 * Every call reads the app, profile and accounts it runs after its access check's statement. A
 * profile disabled while that statement waits is refused, and an account reconnected meanwhile
 * runs its new credentials in a new cache scope, whether it holds a key or an OAuth grant. The
 * self-host test entry point holds that statement, so that scenario runs its own development
 * server.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, SessionClients } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { createProfile, Profile } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";

/** A key-account app whose one read-only tool is listed by a source that reads `resource` first. */
const source = (
  resource: string,
) => `import { defineApp, defineProvider, dynamicRouter, secrets, object, string, query } from "apps";
const service = defineProvider({ name: "Held check fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, {
  tools: dynamicRouter({
    list: async () => {
      await (await fetch(${JSON.stringify(resource)})).text();
      return [{ name: "token", description: "Return the account's token", inputSchema: { type: "object", properties: {} }, readOnly: true }];
    },
    resolve: async (name) => name === "token"
      ? query({ input: object({}), output: string() }, async (ctx) => ctx.accounts.service.fields.token)
      : undefined,
  }),
});`;

const SetupStatus = Schema.Struct({ status: Schema.String });

/** An app without accounts, whose profiles select none. */
const accountless = `import { defineApp, object, string, query, router } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({ ran: query({ input: object({}), output: string() }, async () => "synthetic-ran") }),
});`;
/**
 * An app whose tool returns its account's credential and a value cached for that account, which
 * a reconnect starts again because the account may now sign in as someone else.
 */
const connectionSource = (provider: "key" | "oauth", discover: string) => {
  const [helper, auth, field] =
    provider === "key"
      ? [
          "secrets",
          `key: secrets({ label: "API key", fields: object({ token: string() }) })`,
          "token",
        ]
      : ["oauth2", `oauth: oauth2({ discover: ${JSON.stringify(discover)} })`, "access_token"];
  return `import { defineApp, defineProvider, ${helper}, object, string, query, router } from "apps";
const service = defineProvider({ name: "Held access fixture", auth: { ${auth} } });
export default defineApp({ accounts: { service } }, async ({ accounts, cache }) => ({
  tools: router({
    connection: query({ input: object({}) }, async () => ({
      token: accounts.service.fields.${field},
      scope: await cache.forAccount(accounts.service).get({ key: "connection", schema: string(), freshFor: "1 hour", load: async () => crypto.randomUUID() }),
    })),
  }),
}));`;
};
const Connection = Schema.Struct({ token: Schema.String, scope: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
/** The self-host test host's statement hold; see `apps/hosted/testing/statement-hold-fixture.ts`. */
const statementHold = "/api/devtools/statement-hold";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));

layer(HostedLive, { excludeTestServices: true })("Tool call held check", (it) => {
  it.effect(scenarios.toolCallHeldCheck.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        // A failed assertion must not leave a request held.
        yield* Effect.addFinalizer(() =>
          issuer.configure({ hold: null }).pipe(Effect.andThen(issuer.release)),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Held check ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source(`${issuer.origin}/resource`) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );

        const submit = (connection: string, token: string) =>
          api
            .request(actors.owner, "POST", `${prefix}/connections/${connection}/submit`, {
              method: "key",
              label: "Synthetic",
              fields: { token },
            })
            .pipe(
              Effect.tap((saved) =>
                Effect.sync(() => expect(saved.status, JSON.stringify(saved.body)).toBe(200)),
              ),
              Effect.flatMap((saved) => body(Resource, saved)),
            );
        /** A profile and account of their own, so the first call evaluates a listing of its own. */
        const connect = (token: string) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, path);
            const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            });
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const account = (yield* submit((yield* body(Resource, pending)).id, token)).id;
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
                .pipe(Effect.orDie),
            );
            yield* api.request(actors.owner, "GET", `${path}/profiles/${profile.id}`).pipe(
              Effect.flatMap((response) => body(SetupStatus, response)),
              Effect.flatMap((current) =>
                current.status !== "pending"
                  ? Effect.void
                  : Effect.fail(new Error("Profile setup has not finished")),
              ),
              Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
            );
            return { profile: profile.id, account };
          });

        // Restricted to the app's read-only tools, every call's check evaluates the app.
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeApi;
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
            id: grant.grantId,
            policy: {
              kind: "tools",
              apps: [{ app: app.id, tools: { kind: "readOnly" } }],
              approval: "client",
            },
          })).status,
        ).toBe(200);
        const anonymous = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` };
        /** Hold the call's check inside the app's listing, change saved state, then release it. */
        const heldCall = <E, R>(profile: string, meanwhile: Effect.Effect<unknown, E, R>) =>
          Effect.gen(function* () {
            const before = (yield* issuer.metrics).held;
            yield* issuer.configure({ hold: "resource" });
            const call = yield* Effect.forkChild(
              api.request(
                anonymous,
                "POST",
                `${path}/tools/call`,
                { profile, tool: "token", kind: "query", input: {} },
                headers,
              ),
            );
            yield* issuer.metrics.pipe(
              Effect.flatMap((current) =>
                current.held > before
                  ? Effect.void
                  : Effect.fail(new Error("The call's check did not reach the app's listing")),
              ),
              Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
            );
            yield* meanwhile;
            yield* issuer.configure({ hold: null });
            yield* issuer.release;
            return yield* Fiber.join(call);
          });

        const disabled = yield* connect("synthetic-held-disabled");
        const current = yield* body(
          Profile,
          yield* api.request(actors.owner, "GET", `${path}/profiles/${disabled.profile}`),
        );
        const refused = yield* heldCall(
          disabled.profile,
          api
            .request(actors.owner, "PATCH", `${path}/profiles/${disabled.profile}/enabled`, {
              expectedRevision: current.revision,
              enabled: false,
            })
            .pipe(Effect.map((response) => expect(response.status).toBe(200))),
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);

        const rotated = yield* connect("synthetic-held-before");
        const reconnected = yield* heldCall(
          rotated.profile,
          Effect.gen(function* () {
            const reconnect = yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: rotated.profile,
              account: rotated.account,
            });
            expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(200);
            const saved = yield* submit(
              (yield* body(Resource, reconnect)).id,
              "synthetic-held-after",
            );
            expect(saved.id).toBe(rotated.account);
          }),
        );
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
        expect(yield* body(Schema.String, reconnected)).toBe("synthetic-held-after");
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.toolCallHeldAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          http = yield* HttpClient.HttpClient,
          issuer = yield* oauthSetupIssuer;
        // Only the test entry point mounts the statement hold.
        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session(),
          headers = { origin };
        const send = (
          method: "GET" | "POST" | "PATCH" | "DELETE",
          path: string,
          payload?: unknown,
        ) => api.request(owner, method, `${origin}${path}`, payload, headers);
        expect((yield* send("POST", "/api/devtools/operator", {})).status).toBe(200);
        const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
        const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
        if (!developer) return yield* Effect.die("Development owner is missing");
        expect(
          (yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id }))
            .status,
        ).toBe(200);
        const organization = (yield* body(
          Organizations,
          yield* send("GET", "/api/auth/organization/list"),
        ))[0];
        if (!organization) return yield* Effect.die("Development organization is missing");
        const prefix = `/api/organizations/${organization.id}`;
        // A failed assertion must not leave a statement held.
        yield* Effect.addFinalizer(() => send("DELETE", statementHold).pipe(Effect.orDie));
        yield* Effect.addFinalizer(() => issuer.configure({ tokenShape: null }));

        const deploy = (name: string, content: string) =>
          Effect.gen(function* () {
            const deployed = yield* send("POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            const path = `${prefix}/apps/${app.id}`;
            yield* Effect.addFinalizer(() => send("DELETE", path).pipe(Effect.orDie));
            const profile = yield* body(
              Profile,
              yield* send("POST", `${path}/profiles`, {
                accounts: {},
                idempotencyKey: randomUUID(),
              }),
            );
            return { app: app.id, path, profile: profile.id };
          });
        const callOf = (path: string, profile: string, tool: string) =>
          send("POST", `${path}/tools/call`, { profile, tool, kind: "query", input: {} });
        /** Hold the call's access check for this app, change saved state, then release it. */
        const heldCall = <E, R>(
          app: string,
          call: ReturnType<typeof send>,
          meanwhile: Effect.Effect<unknown, E, R>,
        ) =>
          Effect.gen(function* () {
            expect((yield* send("POST", statementHold, { app })).status).toBe(200);
            const fiber = yield* Effect.forkChild(call);
            yield* send("GET", statementHold).pipe(
              Effect.flatMap((response) => body(Held, response)),
              Effect.flatMap((current) =>
                current.held
                  ? Effect.void
                  : Effect.fail(new Error("The call's access check was not held")),
              ),
              Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
            );
            yield* meanwhile;
            yield* send("DELETE", statementHold);
            return yield* Fiber.join(fiber);
          });
        const disable = (path: string, profile: string) =>
          Effect.gen(function* () {
            const current = yield* body(Profile, yield* send("GET", `${path}/profiles/${profile}`));
            const disabled = yield* send("PATCH", `${path}/profiles/${profile}/enabled`, {
              expectedRevision: current.revision,
              enabled: false,
            });
            expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
          });

        // A profile that selects no accounts.
        const empty = yield* deploy("Held access", accountless);
        const ran = callOf(empty.path, empty.profile, "ran");
        // Held and released with nothing changed, the call runs.
        const unchanged = yield* heldCall(empty.app, ran, Effect.void);
        expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
        expect(yield* body(Schema.String, unchanged)).toBe("synthetic-ran");
        const refused = yield* heldCall(empty.app, ran, disable(empty.path, empty.profile));
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);

        /** Save the connection's credential: a key, or an OAuth sign-in issuing it as the token. */
        const complete = (provider: "key" | "oauth", connection: string, token: string) =>
          Effect.gen(function* () {
            if (provider === "key")
              return yield* body(
                Resource,
                yield* send("POST", `${prefix}/connections/${connection}/submit`, {
                  method: "key",
                  label: "Synthetic",
                  fields: { token },
                }),
              );
            yield* issuer.configure({
              tokenShape: (tokens) => ({ ...tokens, access_token: token }),
            });
            const started = yield* send("POST", `${prefix}/connections/${connection}/oauth/start`, {
              method: "oauth",
              label: "Synthetic OAuth",
            });
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* send(
              "POST",
              `${prefix}/connections/${connection}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return yield* body(Resource, completed);
          });
        const settled = (path: string, profile: string) =>
          send("GET", `${path}/profiles/${profile}`).pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status !== "pending"
                ? Effect.void
                : Effect.fail(new Error("Profile setup has not finished")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );

        // Each held result is checked softly, so one run reports every call that ran stale state.
        for (const provider of ["key", "oauth"] as const) {
          const selected = yield* deploy(
            `Held ${provider} access`,
            connectionSource(provider, `${issuer.origin}/mcp`),
          );
          const pending = yield* body(
            Resource,
            yield* send("POST", `${selected.path}/connections`, {
              requirement: "service",
              profile: selected.profile,
            }),
          );
          const account = (yield* complete(provider, pending.id, "synthetic-held-before")).id;
          yield* Effect.addFinalizer(() =>
            send("DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
          );
          yield* settled(selected.path, selected.profile);
          const call = callOf(selected.path, selected.profile, "connection");
          const first = yield* call;
          expect(first.status, JSON.stringify(first.body)).toBe(200);
          const before = yield* body(Connection, first);
          expect(before.token).toBe("synthetic-held-before");

          const reconnected = yield* heldCall(
            selected.app,
            call,
            Effect.gen(function* () {
              const again = yield* body(
                Resource,
                yield* send("POST", `${selected.path}/connections`, {
                  requirement: "service",
                  profile: selected.profile,
                  account,
                }),
              );
              expect((yield* complete(provider, again.id, "synthetic-held-after")).id).toBe(
                account,
              );
            }),
          );
          expect
            .soft(reconnected.status, `${provider}: ${JSON.stringify(reconnected.body)}`)
            .toBe(200);
          expect
            .soft(reconnected.body, `${provider}: the reconnected account and a new cache scope`)
            .toEqual({
              token: "synthetic-held-after",
              scope: expect.not.stringMatching(`^${before.scope}$`),
            });

          yield* settled(selected.path, selected.profile);
          const disabled = yield* heldCall(
            selected.app,
            call,
            disable(selected.path, selected.profile),
          );
          expect.soft(disabled.status, `${provider}: ${JSON.stringify(disabled.body)}`).toBe(409);
        }
      }),
    ),
  );
});
