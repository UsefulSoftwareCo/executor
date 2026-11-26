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
import {
  linkAccount,
  unlinkAccount,
  connectionsPath,
  requirementPath,
} from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

const source = (
  resource: string,
) => `import { defineApp, defineProvider, dynamicRouter, secrets, object, string, query } from "apps";
const service = defineProvider({ name: "Held check fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, {
  tools: dynamicRouter({
    list: async () => {
      await (await fetch(${JSON.stringify(resource)})).text();
      return [{ name: "token", description: "Return the account's token", inputSchema: { type: "object", properties: {} }, readOnly: true }];
    },
    resolve: async (name) => name === "token"
      ? query({ input: object({}), output: string() }, async (ctx) => ctx.user.accounts.service.fields.token)
      : undefined,
  }),
});`;

const linkedCount = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Held count fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service: service.many() } } }, async (ctx) => ({
  tools: router({ ran: query({ input: object({}), output: string() }, async () => "synthetic-ran-" + ctx.user.accounts.service.length) }),
}));`;
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
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts }, cache }) => ({
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
const statementHold = "/api/devtools/statement-hold";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));

const kindSource = (
  resource: string,
) => `import { defineApp, defineProvider, dynamicRouter, secrets, object, string, query, mutation } from "apps";
const service = defineProvider({ name: "Held kind fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async (ctx) => {
  const readOnly = ctx.user.accounts.service.fields.token === "synthetic-read";
  return {
    tools: dynamicRouter({
      list: async () => {
        await (await fetch(${JSON.stringify(resource)})).text();
        return [{ name: "x", description: "Read with one account, write with another", inputSchema: { type: "object", properties: {} }, readOnly }];
      },
      resolve: async (name) => name !== "x" ? undefined : readOnly
        ? query({ input: object({}), output: string() }, async () => "synthetic-query-ran")
        : mutation({ input: object({}), output: string() }, async () => {
            await fetch(${JSON.stringify(resource)}, { method: "POST", headers: { authorization: "Bearer synthetic-mutation-ran" } });
            return "synthetic-mutation-ran";
          }),
    }),
  };
});`;

const heldListing = (content: (resource: string) => string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser,
      oauth = yield* McpOAuth,
      issuer = yield* oauthSetupIssuer;
    const prefix = `/api/organizations/${actors.organization.id}`;
    yield* Effect.addFinalizer(() =>
      issuer.configure({ hold: null }).pipe(Effect.andThen(issuer.release)),
    );
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Held check ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: content(`${issuer.origin}/resource`) }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    const path = `${prefix}/apps/${app.id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));

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
    const connect = (token: string) =>
      Effect.gen(function* () {
        const pending = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          {},
        );
        expect(pending.status, JSON.stringify(pending.body)).toBe(200);
        const account = (yield* submit((yield* body(Resource, pending)).id, token)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
        );
        return account;
      });

    yield* browser.login(actors.owner);
    const grant = yield* oauth.authorizeApi;
    const narrow = (apps: ReadonlyArray<Record<string, unknown>>) =>
      api
        .request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
          id: grant.grantId,
          policy: {
            kind: "tools",
            apps: apps.map((entry) => ({ app: app.id, ...entry })),
            approval: "client",
          },
        })
        .pipe(
          Effect.map((response) =>
            expect(response.status, JSON.stringify(response.body)).toBe(200),
          ),
        );
    const anonymous = yield* api.session();
    const headers = { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` };
    const call = (input: Record<string, unknown>) =>
      api.request(anonymous, "POST", `${path}/tools/call`, input, headers);
    const heldCall = <E, R>(
      input: Record<string, unknown>,
      meanwhile: Effect.Effect<unknown, E, R>,
    ) =>
      Effect.gen(function* () {
        const before = (yield* issuer.metrics).held;
        yield* issuer.configure({ hold: "resource" });
        const pending = yield* Effect.forkChild(call(input));
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
        return yield* Fiber.join(pending);
      });
    const mutationsRan = issuer.metrics.pipe(
      Effect.map(
        (current) =>
          current.resourceAuthorizations.filter(
            (authorization) => authorization === "Bearer synthetic-mutation-ran",
          ).length,
      ),
    );
    return { api, actors, prefix, path, submit, connect, narrow, call, heldCall, mutationsRan };
  });

layer(HostedLive, { excludeTestServices: true })("Tool call held check", (it) => {
  it.effect(scenarios.toolCallHeldCheck.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, submit, connect, narrow, heldCall } = yield* heldListing(source);
        yield* narrow([{ tools: { kind: "readOnly" } }]);
        const token = { tool: "token", kind: "query", input: {} };

        const unlinked = yield* connect("synthetic-held-unlinked");
        const refused = yield* heldCall(
          token,
          unlinkAccount(actors.owner, path, "service", unlinked),
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body).toMatchObject({ _tag: "AccountRequired" });

        const rotated = yield* connect("synthetic-held-before");
        const reconnected = yield* heldCall(
          token,
          Effect.gen(function* () {
            const reconnect = yield* api.request(
              actors.owner,
              "POST",
              connectionsPath(path, "user", "service"),
              {
                account: rotated,
              },
            );
            expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(200);
            const saved = yield* submit(
              (yield* body(Resource, reconnect)).id,
              "synthetic-held-after",
            );
            expect(saved.id).toBe(rotated);
          }),
        );
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
        expect(yield* body(Schema.String, reconnected)).toBe("synthetic-held-after");
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.toolCallHeldKindSwap.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, connect, narrow, call, heldCall, mutationsRan } =
          yield* heldListing(kindSource);
        const write = yield* connect("synthetic-write");
        const swapped = yield* connect("synthetic-read");
        const unchanged = yield* connect("synthetic-read");
        yield* narrow([
          {
            tools: { kind: "readOnly" },
            targets: [unchanged, swapped, write].map((id) => ({ kind: "account", id })),
          },
        ]);
        const x = { tool: "x", input: {} };
        const control = yield* heldCall(x, Effect.void);
        expect(control.status, JSON.stringify(control.body)).toBe(200);
        expect(control.body).toBe("synthetic-query-ran");

        yield* linkAccount(actors.owner, path, "service", swapped);
        const refused = yield* heldCall(x, linkAccount(actors.owner, path, "service", write));
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body).toMatchObject({ _tag: "OrganizationForbidden" });
        const named = yield* call({ ...x, kind: "mutation" });
        expect(named.status, JSON.stringify(named.body)).toBe(403);
        expect(yield* mutationsRan).toBe(0);
        const own = yield* api.request(actors.owner, "POST", `${path}/tools/call`, x);
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        expect(own.body).toBe("synthetic-mutation-ran");
        expect(yield* mutationsRan).toBe(1);
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.toolCallHeldEntrySwap.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, path, connect, narrow, heldCall, mutationsRan } =
          yield* heldListing(kindSource);
        const write = yield* connect("synthetic-write");
        const swapped = yield* connect("synthetic-read");
        const unchanged = yield* connect("synthetic-read");
        const read = [unchanged, swapped].map((id) => ({ kind: "account", id }));
        yield* narrow([
          { tools: { kind: "selected", names: ["x"] }, targets: read },
          {
            tools: { kind: "selected", names: ["y"] },
            targets: [{ kind: "account", id: write }],
          },
          { tools: { kind: "readOnly" }, targets: read },
        ]);
        const x = { tool: "x", input: {} };
        const control = yield* heldCall(x, Effect.void);
        expect(control.status, JSON.stringify(control.body)).toBe(200);
        expect(control.body).toBe("synthetic-query-ran");

        yield* linkAccount(actors.owner, path, "service", swapped);
        const refused = yield* heldCall(x, linkAccount(actors.owner, path, "service", write));
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body).toMatchObject({ _tag: "OrganizationForbidden" });
        expect(yield* mutationsRan).toBe(0);
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
        const origin = yield* startDevelopmentServer(target);
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session(),
          headers = { origin };
        const send = (
          method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
            return { app: app.id, path };
          });
        const callOf = (path: string, tool: string) =>
          send("POST", `${path}/tools/call`, { tool, kind: "query", input: {} });
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
        const changeLink = (method: "PUT" | "DELETE", path: string, account: string) =>
          send(method, `${requirementPath(path, "user", "service")}/${account}`).pipe(
            Effect.map((response) =>
              expect(response.status, JSON.stringify(response.body)).toBe(200),
            ),
          );

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

        const empty = yield* deploy("Held access", linkedCount);
        const saved = yield* body(
          Resource,
          yield* send("POST", connectionsPath(empty.path, "user", "service"), {}),
        );
        const spare = (yield* complete("key", saved.id, "synthetic-held-spare")).id;
        yield* Effect.addFinalizer(() =>
          send("DELETE", `${prefix}/accounts/${spare}`).pipe(Effect.orDie),
        );
        yield* changeLink("DELETE", empty.path, spare);
        const ran = callOf(empty.path, "ran");
        const unchanged = yield* heldCall(empty.app, ran, Effect.void);
        expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
        expect(yield* body(Schema.String, unchanged)).toBe("synthetic-ran-0");
        const linked = yield* heldCall(empty.app, ran, changeLink("PUT", empty.path, spare));
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);
        expect(yield* body(Schema.String, linked)).toBe("synthetic-ran-1");

        for (const provider of ["key", "oauth"] as const) {
          const selected = yield* deploy(
            `Held ${provider} access`,
            connectionSource(provider, `${issuer.origin}/mcp`),
          );
          const pending = yield* body(
            Resource,
            yield* send("POST", connectionsPath(selected.path, "user", "service"), {}),
          );
          const account = (yield* complete(provider, pending.id, "synthetic-held-before")).id;
          yield* Effect.addFinalizer(() =>
            send("DELETE", `${prefix}/accounts/${account}`).pipe(Effect.orDie),
          );
          const call = callOf(selected.path, "connection");
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
                yield* send("POST", connectionsPath(selected.path, "user", "service"), {
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

          const unlinked = yield* heldCall(
            selected.app,
            call,
            changeLink("DELETE", selected.path, account),
          );
          expect.soft(unlinked.status, `${provider}: ${JSON.stringify(unlinked.body)}`).toBe(409);
        }
      }),
    ),
  );
});
