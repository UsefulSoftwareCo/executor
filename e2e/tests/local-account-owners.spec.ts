/** Local assigns app and account owners itself, so an agent's owner never hides an account. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { ConnectedAccount } from "../support/app-accounts.ts";
import { scenarios } from "../test-plan.ts";

const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    owner: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Connection = Schema.Struct({ id: Schema.String, owner: Schema.String });
const Listed = Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }));
const Providers = Schema.Array(Schema.Struct({ id: Schema.String }));
const Refused = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      response: Schema.Struct({
        code: Schema.String,
        status: Schema.Number,
        message: Schema.String,
      }),
    }),
  }),
});
/** An owner no local app or account has. */
const elsewhere = "someone-else";

layer(TestLive, { excludeTestServices: true })("Local account owners", (it) => {
  it.effect(scenarios.localAccountOwners.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          mcp = yield* McpClient,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        // The agent API takes the host-issued bearer credential, not a browser origin.
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const owned: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(owned, (path) => agent.send("DELETE", path)).pipe(Effect.orDie),
        );

        // An app deployed under another owner belongs to the local user.
        const { app } = yield* body(
          Deployed,
          yield* agent.send("POST", "/v1/apps/deploy", {
            owner: elsewhere,
            name: `Owned ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Owner fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
              },
              appsManifest,
            ],
          }),
        );
        owned.unshift(`/v1/apps/${app.id}`);
        expect(app.owner).toBe("local");
        const provider = app.requirements.accounts.service.provider;
        const requirement = { app: app.id, requirement: "service" };

        // A connection request naming another owner saves the account under the app's owner.
        const link = yield* body(
          Link,
          yield* agent.send("POST", "/account-connect/api/requests", {
            owner: elsewhere,
            target: requirement,
          }),
        );
        const account = yield* body(
          ConnectedAccount,
          yield* agent.send("POST", "/account-connect/api/submit", {
            connection: link.connection,
            token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
            method: "key",
            label: "Owner fixture key",
            fields: { token: "synthetic-owner-token" },
          }),
        );
        owned.push(`/v1/accounts/${account.id}`);
        const listed = (owner: string) =>
          agent
            .send("GET", `/v1/accounts?owner=${owner}`)
            .pipe(Effect.flatMap((response) => body(Listed, response)));
        expect((yield* listed("local")).map(({ id }) => id)).toEqual([account.id]);
        expect(yield* listed(elsewhere)).toEqual([]);
        // The SDK's own connection route ignores the caller's owner the same way.
        const pending = yield* body(
          Connection,
          yield* agent.send("POST", "/v1/account-connections", {
            owner: elsewhere,
            target: requirement,
          }),
        );
        expect(pending.owner).toBe("local");
        expect(
          (yield* agent.send("POST", `/v1/account-connections/${pending.id}/cancel`)).status,
        ).toBe(200);

        // Providers are read for one owner: the providers of that owner's accounts.
        const providers = (owner: string) =>
          agent
            .send("GET", `/v1/providers?owner=${owner}`)
            .pipe(Effect.flatMap((response) => body(Providers, response)));
        expect((yield* providers("local")).map(({ id }) => id)).toEqual([provider]);
        const host = (yield* providers("executor-local")).map(({ id }) => id);
        expect(host).toHaveLength(1);
        expect(host).not.toContain(provider);
        expect(yield* providers(elsewhere)).toEqual([]);

        // Listing never spans owners: a read without one is refused with `RequestInvalid`, as every
        // SDK route refuses a request its schema rejects, and the Executor app's tools name the
        // missing owner to the agent.
        for (const path of ["/v1/accounts", "/v1/providers"])
          expect(yield* agent.send("GET", path)).toEqual({
            status: 400,
            body: {
              _tag: "RequestInvalid",
              message:
                "Could not accept this request's input. Check it against the operation's schema; submitted values are not repeated here.",
            },
          });
        const client = yield* mcp.connect(target.apiKey, "local-account-owners");
        for (const operation of ["list", "providers"]) {
          const refused = yield* client.use(
            `List ${operation} without an owner`,
            (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools.executor.accounts.${operation}({ query: {} });`,
                  },
                },
                undefined,
                { signal },
              ),
          );
          const { response } = (yield* Schema.decodeUnknownEffect(Refused)(
            refused.structuredContent,
          )).execution.error;
          expect(response).toMatchObject({ code: "InputInvalid" });
          expect(response.message).toContain("input.query.owner: Missing key");
        }

        // The dashboard lists the account and manages it.
        const pair = yield* body(
          Schema.Struct({ url: Schema.String }),
          yield* session.send("POST", "/auth/pair", undefined, headers),
        );
        yield* browser.use("Pair the local dashboard", (page) => page.goto(pair.url));
        yield* browser.use("Wait for pairing to finish", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the account list", (page) => page.goto("/accounts"));
        const manage = (label: string, action: string) =>
          browser.use(`${action} ${label}`, (page) =>
            page
              .getByRole("button", { name: `Manage ${label}`, exact: true })
              .click()
              .then(() => page.getByRole("menuitem", { name: action, exact: true }).click()),
          );
        yield* manage("Owner fixture key", "Edit details");
        yield* browser.use("Rename the account", (page) =>
          page
            .getByRole("dialog")
            .getByRole("textbox", { name: "Account name", exact: true })
            .fill("Renamed owner key")
            .then(() => page.getByRole("dialog").getByRole("button", { name: "Save" }).click())
            .then(() => page.getByRole("dialog").waitFor({ state: "hidden" })),
        );
        expect((yield* listed("local")).map(({ label }) => label)).toEqual(["Renamed owner key"]);
        yield* browser.checkpoint("An agent's owner still leaves the account in the dashboard");
        yield* manage("Renamed owner key", "Disconnect account");
        yield* browser.use("Disconnect the account", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Disconnect account", exact: true })
            .click()
            .then(() => page.getByRole("dialog").waitFor({ state: "hidden" })),
        );
        yield* browser.use("The account leaves the list", (page) =>
          page
            .getByRole("button", { name: "Manage Renamed owner key", exact: true })
            .waitFor({ state: "detached" }),
        );
        expect(yield* listed("local")).toEqual([]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localReservedOwners.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          yield* agent.send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Reserved ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, router } from "apps";
export default defineApp({}, { tools: router({}) });`,
              },
              appsManifest,
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          agent.send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie),
        );
        const apps = agent
          .send("GET", "/v1/apps")
          .pipe(
            Effect.flatMap((response) =>
              body(
                Schema.Array(Schema.Struct({ id: Schema.String, owner: Schema.String })),
                response,
              ),
            ),
          );
        const before = yield* apps;
        expect(before.map(({ owner }) => owner).toSorted()).toEqual(
          expect.arrayContaining(["executor-local", "local"]),
        );
        // Removing `local` would delete every record of the local user, and `executor-local` the
        // server's own Executor app. Neither route exists, so neither can be called.
        for (const owner of ["local", "executor-local"]) {
          expect((yield* agent.send("DELETE", `/v1/owners/${owner}`)).status, owner).toBe(404);
          expect((yield* agent.send("GET", `/v1/owners/${owner}/removable`)).status, owner).toBe(
            404,
          );
        }
        expect(yield* apps).toEqual(before);
      }),
    ),
  );
});
