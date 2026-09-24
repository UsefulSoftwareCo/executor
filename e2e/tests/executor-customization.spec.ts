/** Customized management apps retain personal bindings through the browser and MCP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { saveAndDeploy } from "../support/app-authoring.ts";
import { managementApp } from "../support/management-app.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { scenarios } from "../test-plan.ts";
const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  activeDeployment: Schema.String,
  accounts: Schema.optional(Schema.Never),
});
const Inventory = Schema.Struct({
  apps: Schema.Array(App),
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, method: Schema.String, label: Schema.String }),
  ),
});
const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  accounts: Schema.Struct({ service: Schema.String }),
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Identity = Schema.Struct({ organization: Schema.String, role: Schema.String });
layer(HostedLive, { excludeTestServices: true })("Executor customization", (it) => {
  it.effect(scenarios.executorCustomization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const { app, profile: provisioned } = yield* managementApp(actors.owner);
        const own = yield* Schema.decodeUnknownEffect(Profile)(provisioned);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const path = `${prefix}/apps/${app.id}`;
        const read = (actor: typeof actors.owner) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Inventory, response)),
          );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${own.accounts.service}`, {
            label: "My Executor key",
          })).status,
        ).toBe(200);
        const original = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${path}/source`),
        );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* saveAndDeploy(actors.owner, path, {
              files: original.files,
            });
          }).pipe(Effect.orDie),
        );
        const modified = original.files.map((file) =>
          file.path === "index.ts"
            ? { ...file, content: file.content + "\n// User customization\n" }
            : file,
        );
        const edited = yield* body(
          Schema.Struct({ app: App }),
          yield* saveAndDeploy(actors.owner, path, {
            files: modified,
          }),
        );
        const [afterEdit, saved] = yield* Effect.all(
          [
            read(actors.owner),
            api
              .request(actors.owner, "GET", `${path}/source`)
              .pipe(Effect.flatMap((response) => body(Source, response))),
          ],
          { concurrency: 2 },
        );
        expect(afterEdit.apps.find((item) => item.id === app.id)?.activeDeployment).toBe(
          edited.app.activeDeployment,
        );
        expect(saved.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(
          modified.toSorted((a, b) => a.path.localeCompare(b.path)),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Open the user's Executor profile", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=accounts&profile=${own.id}`,
          ),
        );
        yield* browser.use("The managed account is selected in the picker", (page) =>
          page.getByText("My Executor key", { exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Executor uses a personal profile of the common app");
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "executor-key-profile",
        );
        const called = yield* client.use(
          "Run the default app through its personal MCP target",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(app.slug)}].profiles[${JSON.stringify(own.id)}].queries.context_get({});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literal("completed"),
            execution: Schema.Struct({ ok: Schema.Literal(true), value: Identity }),
          }),
        )(called.structuredContent);
        expect(result.execution.value).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
