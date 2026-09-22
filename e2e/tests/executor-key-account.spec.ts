/** Default management keys are ordinary personal accounts bound to one profile per user. */
import { saveAndDeploy } from "../support/app-authoring.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  activeDeployment: Schema.String,
  accounts: Schema.Record(Schema.String, Schema.String),
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
layer(HostedLive, { excludeTestServices: true })("Executor API-key account", (it) => {
  it.effect(scenarios.executorKeyAccount.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const read = (actor: Session) =>
          api.request(actor, "GET", `${prefix}/inventory`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Inventory, response)),
          );
        const reads = yield* Effect.forEach([0, 1, 2, 3], () => read(actors.owner), {
          concurrency: 4,
        });
        const initial = reads[0],
          app = initial?.apps.find((app) => app.name === "Executor");
        if (!initial || !app) return yield* Effect.die("Default Executor app missing");
        expect(app.accounts).toEqual({});
        const path = `${prefix}/apps/${app.id}`;
        const profile = (actor: Session) =>
          Effect.gen(function* () {
            const rows = yield* body(
              Schema.Array(Profile),
              yield* api.request(actor, "GET", `${path}/profiles`),
            );
            expect(rows).toHaveLength(1);
            const row = rows[0];
            if (!row) return yield* Effect.die("Default profile missing");
            return row;
          });
        const own = yield* profile(actors.owner),
          account = own.accounts.service;
        expect(initial.accounts.find((item) => item.id === account)?.method).toBe("apiKey");
        const nativeKeys = yield* body(
          Schema.Struct({
            apiKeys: Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
          }),
          yield* api.request(actors.owner, "GET", "/api/auth/api-key/list"),
        );
        expect(nativeKeys.apiKeys.filter((key) => key.name === "Executor app")).toHaveLength(1);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/accounts/${account}`, {
            label: "My Executor key",
          })).status,
        ).toBe(200);
        for (const inventory of yield* Effect.forEach([0, 1, 2, 3], () => read(actors.owner), {
          concurrency: 4,
        })) {
          expect(inventory.apps.find((item) => item.id === app.id)?.accounts).toEqual({});
          expect(
            inventory.accounts.filter((item) => item.method === "apiKey").map((item) => item.id),
          ).toEqual([account]);
          expect(inventory.accounts.find((item) => item.id === account)?.label).toBe(
            "My Executor key",
          );
        }
        expect((yield* profile(actors.owner)).id).toBe(own.id);
        const adminInventory = yield* read(actors.admin),
          admin = yield* profile(actors.admin);
        expect(admin.id).not.toBe(own.id);
        expect(admin.accounts.service).not.toBe(account);
        expect(adminInventory.accounts.some((item) => item.id === account)).toBe(false);
        const call = (actor: Session, profile: string) =>
          api.request(actor, "POST", `${path}/tools/call`, {
            profile,
            tool: "queries.context_get",
            input: {},
          });
        const ownerCall = yield* call(actors.owner, own.id);
        expect(ownerCall.status, JSON.stringify(ownerCall.body)).toBe(200);
        expect(yield* body(Identity, ownerCall)).toEqual({
          organization: actors.organization.id,
          role: "owner",
        });
        const adminCall = yield* call(actors.admin, admin.id);
        expect(adminCall.status).toBe(200);
        expect(yield* body(Identity, adminCall)).toEqual({
          organization: actors.organization.id,
          role: "admin",
        });
        expect((yield* call(actors.admin, own.id)).status).toBe(403);
        const connection = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.owner, "POST", `${path}/connections`, {
            profile: own.id,
            requirement: "service",
          }),
        );
        const manual = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${connection.id}/submit`,
            {
              method: "apiKey",
              label: "Manual key",
              fields: { token: "synthetic-manual-key", organization: actors.organization.id },
            },
          ),
        );
        yield* read(actors.owner);
        const chosen = yield* profile(actors.owner);
        expect(chosen.accounts.service).toBe(manual.id);
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/profiles/${own.id}`, {
            expectedRevision: chosen.revision,
            accounts: { service: account },
          })).status,
        ).toBe(200);
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${manual.id}`)).status,
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
        expect(
          (yield* read(actors.owner)).apps.find((item) => item.id === app.id)?.activeDeployment,
        ).toBe(edited.app.activeDeployment);
        expect(
          (yield* body(Source, yield* api.request(actors.owner, "GET", `${path}/source`))).files,
        ).toEqual(modified);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the user's Executor profile", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${app.id}?view=accounts&profile=${own.id}`,
          ),
        );
        yield* browser.use("The managed account is selected in the picker", (page) =>
          page
            .getByRole("combobox", { name: "App accounts", exact: true })
            .filter({ hasText: "My Executor key" })
            .waitFor(),
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
