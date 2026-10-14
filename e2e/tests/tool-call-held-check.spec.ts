/**
 * A read-only rule decides a tool call by the tool's live metadata, so its check evaluates the app
 * before the call runs, for as long as the app takes. The call runs the links and credentials
 * saved after that check, not those read before it: an account unlinked or reconnected while the
 * check waits takes effect on that call. The app's listing reads a loopback resource that holds
 * the check until the scenario has changed the saved state. The grant is checked against the
 * accounts the call runs with: a link replaced meanwhile by an account with which the tool is a
 * mutation, or which only another entry of the grant permits, is refused before the tool runs.
 *
 * Every call reads the caller's links in its access check's statement, and the app and accounts it
 * runs after it. An account linked or unlinked while that statement waits takes effect on the
 * call, and an account reconnected meanwhile runs its new credentials in a new cache scope,
 * whether it holds a key or an OAuth grant. The self-host test entry point holds that statement,
 * so that scenario runs its own development server.
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
import {
  linkAccount,
  unlinkAccount,
  connectionsPath,
  requirementPath,
} from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

/** A key-account app whose one read-only tool is listed by a source that reads `resource` first. */
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

/** An app whose requirement uses every linked account, and reports how many it ran with. */
const linkedCount = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
const service = defineProvider({ name: "Held count fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service: service.many() } } }, async (ctx) => ({
  tools: router({ ran: query({ input: object({}), output: string() }, async () => "synthetic-ran-" + ctx.user.accounts.service.length) }),
}));`;
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
/** The self-host test host's statement hold; see `apps/hosted/testing/statement-hold-fixture.ts`. */
const statementHold = "/api/devtools/statement-hold";
const Held = Schema.Struct({ held: Schema.Boolean });
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));

/**
 * An app whose tool `x` is a read-only query while the caller's linked account holds
 * `synthetic-read`, and a mutation that writes to `resource` with any other. The listing reads
 * `resource` first, so a read-only rule's check can be held inside it.
 */
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

/**
 * An app deployed from `content` and an MCP grant of the owner's, whose calls are held inside the
 * app's listing while the scenario changes saved state. The listing reads the issuer's resource.
 */
const heldListing = (content: (resource: string) => string) =>
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
    /**
     * An account connected from the app, which links it in place of the one linked before. Each
     * is the only one linked when its call runs, so the call evaluates a listing of its own.
     */
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
    /** Narrow the grant to these entries of the app. */
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
    /** Call a tool through the grant. */
    const call = (input: Record<string, unknown>) =>
      api.request(anonymous, "POST", `${path}/tools/call`, input, headers);
    /** Hold the call's check inside the app's listing, change saved state, then release it. */
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
    /** Requests the app's mutation made to the resource; its listing only reads it. */
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
        // Restricted to the app's read-only tools, every call's check evaluates the app.
        yield* narrow([{ tools: { kind: "readOnly" } }]);
        const token = { tool: "token", kind: "query", input: {} };

        // The only linked account is unlinked while the check waits: the call has no account.
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
        // Each `read` account is linked in turn; the app lists its tools once per account, so
        // each call's check evaluates a listing of its own.
        const write = yield* connect("synthetic-write");
        const swapped = yield* connect("synthetic-read");
        const unchanged = yield* connect("synthetic-read");
        // Read-only tools only, with any of them.
        yield* narrow([
          {
            tools: { kind: "readOnly" },
            targets: [unchanged, swapped, write].map((id) => ({ kind: "account", id })),
          },
        ]);
        const x = { tool: "x", input: {} };
        // Held and released with nothing changed, `x` runs as the query it was listed as.
        const control = yield* heldCall(x, Effect.void);
        expect(control.status, JSON.stringify(control.body)).toBe(200);
        expect(control.body).toBe("synthetic-query-ran");

        // The member's link is replaced while the check reads the listing for a `read` account.
        // With `write`, `x` is a mutation the rule does not permit: the call is refused and the
        // mutation does not run.
        yield* linkAccount(actors.owner, path, "service", swapped);
        const refused = yield* heldCall(x, linkAccount(actors.owner, path, "service", write));
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body).toMatchObject({ _tag: "OrganizationForbidden" });
        // Nor when the caller names the mutation itself, with `write` linked.
        const named = yield* call({ ...x, kind: "mutation" });
        expect(named.status, JSON.stringify(named.body)).toBe(403);
        expect(yield* mutationsRan).toBe(0);
        // The owner's own session, outside the grant, runs it, and the resource records it.
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
        // `x` with a `read` account, `y` with `write`, and read-only tools with a `read` account:
        // no entry permits `x` with `write`.
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

        // Replaced by `write` while the check waits, the call is refused: the entry that permits
        // `x` does not permit `write`, and the entry that permits `write` does not permit `x`.
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
            return { app: app.id, path };
          });
        const callOf = (path: string, tool: string) =>
          send("POST", `${path}/tools/call`, { tool, kind: "query", input: {} });
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
        const changeLink = (method: "PUT" | "DELETE", path: string, account: string) =>
          send(method, `${requirementPath(path, "user", "service")}/${account}`).pipe(
            Effect.map((response) =>
              expect(response.status, JSON.stringify(response.body)).toBe(200),
            ),
          );

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

        // A requirement with no linked accounts: its saved account was connected, then unlinked.
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
        // Held and released with nothing changed, the call runs.
        const unchanged = yield* heldCall(empty.app, ran, Effect.void);
        expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
        expect(yield* body(Schema.String, unchanged)).toBe("synthetic-ran-0");
        // An account linked while the statement waits is one the call runs with.
        const linked = yield* heldCall(empty.app, ran, changeLink("PUT", empty.path, spare));
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);
        expect(yield* body(Schema.String, linked)).toBe("synthetic-ran-1");

        // Each held result is checked softly, so one run reports every call that ran stale state.
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

          // Unlinked while the statement waits, the only account is not run.
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
