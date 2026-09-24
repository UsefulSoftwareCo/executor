import { localAppBrowserHandlers } from "../src/implementation/app-browser.ts";
import { localScheduleHandlers } from "../src/implementation/schedules.ts";
import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Generated apps run through real product HTTP contracts, storage, and the local Node runtime. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { buildSchema, graphql } from "graphql";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { OwnerId, ToolName, createExecutor, type Executor } from "@executor-js/sdk/core";
import { nodeRuntime } from "@executor-js/sdk/node";
import { DashboardApi } from "../src/contracts/dashboard.ts";
import { ServerConfig } from "../src/contracts/config.ts";
import { dashboard } from "../src/implementation/dashboard.ts";
import { aesGcmCredentials as credentials } from "@executor-js/sdk/core";
import { openStorage } from "../src/implementation/storage.ts";
import { makeLocalAuth, sessionCookie, type LocalAuth } from "../src/implementation/auth.ts";
import { createCatalog, type CatalogEntry } from "@executor-js/catalog";
import { defaultUrlPolicy, type HostEgress } from "@executor-js/utils/url-policy";
import { withRemoteMcp } from "./fixtures/remote-mcp.ts";

const entry = {
  id: "fixture",
  name: "Fixture API",
  description: "Test API",
  domain: "example.test",
  kind: "openapi" as const,
  connectUrl: "https://example.test/openapi.json",
};
const apiKey = "synthetic-catalog-local-key-0000000000";

/** These fixtures declare no approval; assert completion before checking their provider payloads. */
const completedCall = async (
  executor: Executor,
  input: Parameters<Executor["tools"]["call"]>[0],
) => {
  const result = await Effect.runPromise(executor.tools.call(input));
  assert.ok(result.status === "completed", "Fixture tool must complete without approval");
  return result.value;
};
// Fixture servers run on loopback, which is exactly what the local product's policy allows.
// These cases exercise catalog behaviour, not egress, so the platform fetch client is enough.
const egress: HostEgress = {
  policy: defaultUrlPolicy,
  client: Effect.runSync(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))),
};
const catalogFor = (entry: CatalogEntry, document?: unknown) =>
  createCatalog(egress, {
    list: Effect.succeed([entry]),
    document: () => Effect.succeed(document),
  });
const spec = (baseUrl: string) => ({
  openapi: "3.0.3",
  servers: [{ url: baseUrl }],
  security: [{ key: [] }],
  components: {
    securitySchemes: {
      key: { type: "apiKey", in: "header", name: "X-Api-Key" },
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://example.test/authorize",
            tokenUrl: "https://example.test/token",
            scopes: { read: "Read" },
          },
        },
      },
    },
  },
  paths: {
    "/items/{id}": {
      get: {
        operationId: "getItem",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
        ],
      },
    },
    "/items": {
      post: {
        operationId: "createItem",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", minLength: 2 } },
                additionalProperties: false,
              },
            },
          },
        },
      },
    },
    "/binary": {
      post: {
        operationId: "upload",
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
    "/public": { get: { operationId: "publicInfo", security: [] } },
  },
});

async function withServer(
  document: unknown,
  run: (
    executor: Executor,
    client: Awaited<ReturnType<typeof reader>>,
    context: { auth: LocalAuth; url: string; port: number },
  ) => Promise<void>,
  catalogEntry: CatalogEntry = entry,
) {
  let executor: Executor | undefined;
  let auth: LocalAuth | undefined;
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const server = yield* HttpServer.HttpServer;
          if (server.address._tag !== "InetAddressV4") throw new Error("TCP listener required");
          const config = Schema.decodeUnknownSync(ServerConfig)({
            directory,
            port: server.address.port,
            apiKey,
            encryptionKey: "ab".repeat(32),
          });
          const storage = yield* openStorage(directory);
          const store = yield* credentials(config.encryptionKey, crypto);
          executor = yield* createExecutor({
            blobs: memoryBlobStore(),
            sources: memorySourceStorage(),
            storage,
            credentials: store,
            runtime: nodeRuntime({ workDirectory: path.join(directory, "builds") }),
          });
          auth = yield* makeLocalAuth(crypto, directory);
          const api = dashboard(executor, storage, store, config, auth, egress, {
            catalog: {
              list: Effect.succeed([catalogEntry]),
              document: () => Effect.succeed(document),
            },
          });
          return HttpApiBuilder.layer(DashboardApi).pipe(
            Layer.provide(api.handlers),
            Layer.provide(localScheduleHandlers(executor, config, auth)),
            Layer.provide(localAppBrowserHandlers(executor)),
            Layer.provide(api.access),
          );
        }),
      ),
      { disableLogger: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.provide(NodeServices.layer),
    ),
  );
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer);
    if (server.address._tag !== "InetAddressV4" || !executor || !auth)
      throw new Error("Server failed to start");
    const url = `http://127.0.0.1:${server.address.port}`;
    await run(executor, await reader(url), { auth, url, port: server.address.port });
  } finally {
    await runtime.dispose();
  }
}
const reader = (
  baseUrl: string,
  headers: Record<string, string> = { authorization: `Bearer ${apiKey}` },
) =>
  Effect.runPromise(
    HttpApiClient.make(DashboardApi, {
      baseUrl,
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeaders({ ...headers, origin: baseUrl })),
        ),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

test("deleting an app keeps reusable accounts and independent copies", async () => {
  await withServer(spec("https://api.example.test"), async (executor, client) => {
    const first = await Effect.runPromise(
      client.dashboard.importApp({ payload: { entry: entry.id, name: "Delete fixture" } }),
    );
    const firstProfile = await Effect.runPromise(
      executor.apps.profiles.create({
        app: first.id,
        owner: first.owner,
        subject: "local",
        idempotencyKey: "test",
        accounts: {},
      }),
    );
    const requirement = first.requirements.accounts.service;
    assert.ok(requirement);
    const account = await Effect.runPromise(
      client.dashboard.addAccount({
        payload: {
          provider: requirement.provider,
          method: "apiKey",
          label: "Reusable account",
          fields: Redacted.make({ token: "synthetic-key" }),
        },
      }),
    );
    await Effect.runPromise(
      executor.apps.profiles.update({
        app: first.id,
        profile: firstProfile.id,
        accounts: { service: account.id },
        expectedRevision: (
          await Effect.runPromise(
            executor.apps.profiles.get({ app: first.id, profile: firstProfile.id }),
          )
        ).revision,
      }),
    );
    const second = await Effect.runPromise(
      executor.apps.copy({ from: first.id, owner: OwnerId.make("local"), name: "Kept copy" }),
    );
    const secondProfile = await Effect.runPromise(
      executor.apps.profiles.create({
        app: second.id,
        owner: second.owner,
        subject: "local",
        idempotencyKey: "test",
        accounts: {},
      }),
    );
    await Effect.runPromise(
      executor.apps.profiles.update({
        app: second.id,
        profile: secondProfile.id,
        accounts: { service: account.id },
        expectedRevision: (
          await Effect.runPromise(
            executor.apps.profiles.get({ app: second.id, profile: secondProfile.id }),
          )
        ).revision,
      }),
    );

    await Effect.runPromise(
      executor.apps.remove({ app: first.id, owner: OwnerId.make("someone-else") }),
    );
    assert.equal((await Effect.runPromise(executor.apps.get({ app: first.id }))).id, first.id);
    assert.equal(
      (await Effect.runPromise(client.dashboard.app({ params: { app: first.id } }))).canDelete,
      true,
    );
    await Effect.runPromise(client.dashboard.deleteApp({ params: { app: first.id } }));
    await Effect.runPromise(client.dashboard.deleteApp({ params: { app: first.id } }));

    const inventory = await Effect.runPromise(client.dashboard.overview());
    assert.equal(
      inventory.apps.some((app) => app.id === first.id),
      false,
    );
    assert.equal(
      inventory.accounts.some((item) => item.id === account.id),
      true,
    );
    assert.equal(
      (await Effect.runPromise(executor.accounts.get({ account: account.id }))).provider,
      account.provider,
    );
    assert.equal(
      (
        await Effect.runPromise(
          Effect.flip(executor.tools.list({ profile: firstProfile.id, app: first.id })),
        )
      )._tag,
      "AppNotFound",
    );
    assert.equal(
      (
        await Effect.runPromise(
          executor.apps.profiles.get({ profile: secondProfile.id, app: second.id }),
        )
      ).accounts.service,
      account.id,
    );
    assert.ok(
      (await Effect.runPromise(executor.tools.list({ profile: secondProfile.id, app: second.id })))
        .items.length > 0,
    );
    assert.ok(second.activeDeployment);
    assert.notEqual(second.activeDeployment, first.activeDeployment);
    assert.ok(
      (
        await Effect.runPromise(
          client.dashboard.source({
            params: { app: second.id, deployment: second.activeDeployment },
          }),
        )
      ).files.length > 0,
    );

    const replacement = await Effect.runPromise(
      client.dashboard.importApp({ payload: { entry: entry.id, name: "Delete fixture" } }),
    );
    assert.notEqual(replacement.id, first.id);
  });
});

test("account management preserves shared identity, updates live tools, and separates selection from disconnect", async () => {
  await withRemoteMcp({}, async ({ url }) => {
    const remote: CatalogEntry = {
      ...entry,
      kind: "mcp",
      connectUrl: url,
      auth: { kind: "api_key" },
    };
    await withServer(
      undefined,
      async (executor, client) => {
        const first = await Effect.runPromise(
          client.dashboard.importApp({ payload: { entry: remote.id, name: "Shared first" } }),
        );
        const firstProfile = await Effect.runPromise(
          executor.apps.profiles.create({
            app: first.id,
            owner: first.owner,
            subject: "local",
            idempotencyKey: "test",
            accounts: {},
          }),
        );
        const second = await Effect.runPromise(
          executor.apps.copy({
            from: first.id,
            owner: OwnerId.make("local"),
            name: "Shared second",
          }),
        );
        const secondProfile = await Effect.runPromise(
          executor.apps.profiles.create({
            app: second.id,
            owner: second.owner,
            subject: "local",
            idempotencyKey: "test",
            accounts: {},
          }),
        );
        const provider = first.requirements.accounts.service?.provider;
        assert.ok(provider);
        const account = await Effect.runPromise(
          client.dashboard.addAccount({
            payload: {
              provider,
              method: "apiKey",
              label: "Shared",
              fields: Redacted.make({ token: "alpha" }),
            },
          }),
        );
        for (const app of [first, second])
          await Effect.runPromise(
            client.profiles.update({
              params: {
                app: app.id,
                profile: app.id === first.id ? firstProfile.id : secondProfile.id,
              },
              payload: {
                accounts: { service: account.id },
                expectedRevision: (
                  await Effect.runPromise(
                    executor.apps.profiles.get({
                      app: app.id,
                      profile: app.id === first.id ? firstProfile.id : secondProfile.id,
                    }),
                  )
                ).revision,
              },
            }),
          );
        const params = { account: account.id };
        const detail = await Effect.runPromise(client.dashboard.account({ params }));
        assert.deepEqual(new Set(detail.apps.map((app) => app.id)), new Set([first.id, second.id]));
        assert.equal(detail.canManage, true);
        const renamed = await Effect.runPromise(
          client.dashboard.renameAccount({ params, payload: { label: "Renamed" } }),
        );
        assert.deepEqual(renamed, { ...account, label: "Renamed" });
        assert.equal(
          (
            await Effect.runPromise(
              Effect.flip(
                executor.accounts.update({
                  ...params,
                  owner: OwnerId.make("other"),
                  label: "Wrong",
                }),
              ),
            )
          )._tag,
          "AccountNotFound",
        );
        assert.equal(
          (
            await Effect.runPromise(
              Effect.flip(
                executor.accounts.replaceCredentials({
                  ...params,
                  owner: OwnerId.make("other"),
                  fields: Redacted.make({ token: "beta" }),
                }),
              ),
            )
          )._tag,
          "AccountNotFound",
        );
        assert.equal(
          (
            await Effect.runPromise(
              Effect.flip(
                client.dashboard.replaceAccountCredentials({
                  params,
                  payload: { fields: Redacted.make({ token: 123 }) },
                }),
              ),
            )
          )._tag,
          "AccountFieldsInvalid",
        );
        assert.equal(
          (
            await Effect.runPromise(
              executor.tools.list({ profile: firstProfile.id, app: first.id }),
            )
          ).items[1]?.name,
          "queries.alpha",
        );

        const replaced = await Effect.runPromise(
          client.dashboard.replaceAccountCredentials({
            params,
            payload: { fields: Redacted.make({ token: "beta" }) },
          }),
        );
        assert.deepEqual(replaced, renamed);
        assert.deepEqual(
          Object.keys(replaced).sort(),
          ["id", "provider", "method", "label", "owner", "createdAt"].sort(),
        );
        for (const app of [first, second]) {
          assert.equal(
            (
              await Effect.runPromise(
                executor.apps.profiles.get({
                  profile: app.id === first.id ? firstProfile.id : secondProfile.id,
                  app: app.id,
                }),
              )
            ).accounts.service,
            account.id,
          );
          assert.equal(
            (
              await Effect.runPromise(
                executor.tools.list({
                  profile: app.id === first.id ? firstProfile.id : secondProfile.id,
                  app: app.id,
                }),
              )
            ).items[1]?.name,
            "queries.beta",
          );
          const called = await Effect.runPromise(
            executor.tools.call({
              profile: app.id === first.id ? firstProfile.id : secondProfile.id,
              app: app.id,
              tool: ToolName.make("queries.beta"),
              input: { value: "test" },
            }),
          );
          assert.ok(JSON.stringify(called).includes('"account":"beta"'));
        }
        await Effect.runPromise(
          client.profiles.update({
            params: { app: first.id, profile: firstProfile.id },
            payload: {
              accounts: {},
              expectedRevision: (
                await Effect.runPromise(
                  executor.apps.profiles.get({ app: first.id, profile: firstProfile.id }),
                )
              ).revision,
            },
          }),
        );
        assert.equal((await Effect.runPromise(executor.accounts.get(params))).id, account.id);
        assert.deepEqual(
          (await Effect.runPromise(client.dashboard.account({ params }))).apps.map((app) => app.id),
          [second.id],
        );
        assert.equal(
          (
            await Effect.runPromise(
              Effect.flip(executor.tools.list({ profile: firstProfile.id, app: first.id })),
            )
          )._tag,
          "AccountRequired",
        );

        // Keeping a second saved account must not turn disconnect into an implicit selection change.
        const alternative = await Effect.runPromise(
          client.dashboard.addAccount({
            payload: {
              provider,
              method: "apiKey",
              label: "Alternative",
              fields: Redacted.make({ token: "alpha" }),
            },
          }),
        );
        await Effect.runPromise(
          executor.accounts.remove({ ...params, owner: OwnerId.make("other") }),
        );
        assert.equal((await Effect.runPromise(executor.accounts.get(params))).id, account.id);
        await Effect.runPromise(client.dashboard.disconnectAccount({ params }));
        await Effect.runPromise(client.dashboard.disconnectAccount({ params }));
        assert.equal(
          (await Effect.runPromise(Effect.flip(client.dashboard.account({ params }))))._tag,
          "AccountNotFound",
        );
        assert.equal(
          (
            await Effect.runPromise(
              executor.apps.profiles.get({ profile: secondProfile.id, app: second.id }),
            )
          ).accounts.service,
          account.id,
        );
        assert.equal(
          (
            await Effect.runPromise(
              Effect.flip(executor.tools.list({ profile: secondProfile.id, app: second.id })),
            )
          )._tag,
          "AccountNotFound",
        );
        assert.equal(
          (await Effect.runPromise(executor.accounts.get({ account: alternative.id }))).id,
          alternative.id,
        );
        await Effect.runPromise(
          client.profiles.update({
            params: { app: second.id, profile: secondProfile.id },
            payload: {
              accounts: {},
              expectedRevision: (
                await Effect.runPromise(
                  executor.apps.profiles.get({ app: second.id, profile: secondProfile.id }),
                )
              ).revision,
            },
          }),
        );
        await Effect.runPromise(client.dashboard.deleteApp({ params: { app: first.id } }));
        await Effect.runPromise(client.dashboard.deleteApp({ params: { app: second.id } }));
        assert.equal(
          (
            await Effect.runPromise(
              client.dashboard.account({ params: { account: alternative.id } }),
            )
          ).provider.id,
          provider,
        );
      },
      remote,
    );
  });
});

test("import, account creation, selection and generated requests use the normal runtime", async () => {
  const requests: Array<{ path: string; key: string | undefined; body: string }> = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const key = request.headers["x-api-key"];
    requests.push({
      path: request.url ?? "",
      key: typeof key === "string" ? key : undefined,
      body,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  try {
    await withServer(spec(`http://127.0.0.1:${address.port}`), async (executor, client) => {
      const app = await Effect.runPromise(
        client.dashboard.importApp({ payload: { entry: entry.id, name: "Imported" } }),
      );
      const appProfile = await Effect.runPromise(
        executor.apps.profiles.create({
          app: app.id,
          owner: app.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: {},
        }),
      );
      const requirement = app.requirements.accounts.service;
      assert.ok(requirement);
      assert.equal(requirement.definition.auth.oauth?.type, "oauth2");
      const account = await Effect.runPromise(
        client.dashboard.addAccount({
          payload: {
            provider: requirement.provider,
            method: "apiKey",
            label: "Test account",
            fields: Redacted.make({ token: "synthetic-key" }),
          },
        }),
      );
      assert.ok(!JSON.stringify(account).includes("synthetic-key"));
      await Effect.runPromise(
        client.profiles.update({
          params: { app: app.id, profile: appProfile.id },
          payload: {
            accounts: { service: account.id },
            expectedRevision: (
              await Effect.runPromise(
                executor.apps.profiles.get({ app: app.id, profile: appProfile.id }),
              )
            ).revision,
          },
        }),
      );
      const page = await Effect.runPromise(
        executor.tools.list({ profile: appProfile.id, app: app.id }),
      );
      assert.equal(page.items.length, 4);
      const tool = page.items.find((tool) => tool.name === "mutations.createItem");
      assert.ok(tool);
      assert.equal(tool.inputSchema.type, "object");
      for (const [tool, input] of [
        ["getItem", { path: { id: "one/two" }, query: { tags: ["a b", "c"] } }],
        ["createItem", { body: { name: "Valid" } }],
        ["upload", { body: btoa("binary-data") }],
        ["publicInfo", {}],
      ] as const)
        await Effect.runPromise(
          executor.tools.call({
            profile: appProfile.id,
            app: app.id,
            tool: ToolName.make(
              `${["getItem", "publicInfo"].includes(tool) ? "queries" : "mutations"}.${tool}`,
            ),
            input,
          }),
        );
      assert.deepEqual(requests, [
        { path: "/items/one%2Ftwo?tags=a+b&tags=c", key: "synthetic-key", body: "" },
        { path: "/items", key: "synthetic-key", body: '{"name":"Valid"}' },
        { path: "/binary", key: "synthetic-key", body: "binary-data" },
        { path: "/public", key: undefined, body: "" },
      ]);
      await assert.rejects(() =>
        Effect.runPromise(
          executor.tools.call({
            profile: appProfile.id,
            app: app.id,
            tool: ToolName.make("mutations.createItem"),
            input: { body: { name: "x" } },
          }),
        ),
      );
      assert.equal(requests.length, 4);
      await assert.rejects(
        () =>
          Effect.runPromise(
            client.dashboard.importApp({ payload: { entry: entry.id, name: "Imported" } }),
          ),
        (error: unknown) =>
          Schema.is(Schema.Struct({ _tag: Schema.Literal("AppNameTaken") }))(error),
      );
      const second = await Effect.runPromise(
        client.dashboard.importApp({ payload: { entry: entry.id, name: "Second" } }),
      );
      const secondProfile = await Effect.runPromise(
        executor.apps.profiles.create({
          app: second.id,
          owner: second.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: {},
        }),
      );
      assert.equal(second.requirements.accounts.service?.provider, requirement.provider);
      await Effect.runPromise(
        client.profiles.update({
          params: { app: second.id, profile: secondProfile.id },
          payload: {
            accounts: { service: account.id },
            expectedRevision: (
              await Effect.runPromise(
                executor.apps.profiles.get({ app: second.id, profile: secondProfile.id }),
              )
            ).revision,
          },
        }),
      );
      assert.equal((await Effect.runPromise(client.dashboard.overview({}))).accounts.length, 1);
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("unsupported security fails before generating misleading app source", async () => {
  // Without the public operation, no operation has a usable authentication method.
  const { "/public": _public, ...paths } = spec("https://example.test").paths;
  await assert.rejects(
    () =>
      Effect.runPromise(
        catalogFor(entry, {
          ...spec("https://example.test"),
          paths,
          components: { securitySchemes: { key: { type: "http", scheme: "digest" } } },
        })
          .prepare({ entry: entry.id })
          .pipe(Effect.provide(NodeServices.layer)),
      ),
    { code: "no_supported_operations" },
  );
});

test("MCP catalog imports build normal apps and keep each account's live tools and calls separate", async () => {
  await withRemoteMcp({}, async ({ url, calls, sessions }) => {
    const remote: CatalogEntry = {
      ...entry,
      kind: "mcp",
      connectUrl: url,
      auth: { kind: "api_key" },
    };
    await withServer(
      undefined,
      async (executor, client) => {
        const first = await Effect.runPromise(
          client.dashboard.importApp({ payload: { entry: remote.id, name: "First MCP" } }),
        );
        const firstProfile = await Effect.runPromise(
          executor.apps.profiles.create({
            app: first.id,
            owner: first.owner,
            subject: "local",
            idempotencyKey: "test",
            accounts: {},
          }),
        );
        const second = await Effect.runPromise(
          client.dashboard.importApp({ payload: { entry: remote.id, name: "Second MCP" } }),
        );
        const secondProfile = await Effect.runPromise(
          executor.apps.profiles.create({
            app: second.id,
            owner: second.owner,
            subject: "local",
            idempotencyKey: "test",
            accounts: {},
          }),
        );
        const provider = first.requirements.accounts.service?.provider;
        assert.ok(provider);
        assert.equal(second.requirements.accounts.service?.provider, provider);
        for (const [app, label] of [
          [first, "alpha"],
          [second, "beta"],
        ] as const) {
          const account = await Effect.runPromise(
            client.dashboard.addAccount({
              payload: {
                provider,
                method: "apiKey",
                label,
                fields: Redacted.make({ token: label }),
              },
            }),
          );
          await Effect.runPromise(
            client.profiles.update({
              params: {
                app: app.id,
                profile: app.id === first.id ? firstProfile.id : secondProfile.id,
              },
              payload: {
                accounts: { service: account.id },
                expectedRevision: (
                  await Effect.runPromise(
                    executor.apps.profiles.get({
                      app: app.id,
                      profile: app.id === first.id ? firstProfile.id : secondProfile.id,
                    }),
                  )
                ).revision,
              },
            }),
          );
        }
        const pages = await Promise.all(
          [first, second].map((app) =>
            Effect.runPromise(
              executor.tools.list({
                profile: app.id === first.id ? firstProfile.id : secondProfile.id,
                app: app.id,
              }),
            ),
          ),
        );
        assert.deepEqual(
          pages.map((page) => page.items.map((tool) => tool.name)),
          [
            ["mutations.failure", "queries.alpha"],
            ["mutations.failure", "queries.beta"],
          ],
        );
        const tool = pages[0]?.items[1];
        assert.equal(tool?.title, "Account tool");
        assert.equal(tool?.annotations?.readOnlyHint, true);
        assert.equal(tool?._meta?.fixture, true);
        assert.deepEqual(tool?.outputSchema, {
          type: "object",
          properties: { account: { type: "string" } },
          required: ["account"],
        });
        for (const [app, name] of [
          [first, "alpha"],
          [second, "beta"],
        ] as const) {
          const result = await completedCall(executor, {
            profile: app.id === first.id ? firstProfile.id : secondProfile.id,
            app: app.id,
            tool: ToolName.make(`queries.${name}`),
            input: { value: "hello" },
          });
          assert.deepEqual(result, {
            content: [{ type: "text", text: name }],
            structuredContent: { account: name },
            _meta: { fixture: true },
          });
        }
        const failure = await completedCall(executor, {
          profile: firstProfile.id,
          app: first.id,
          tool: ToolName.make("mutations.failure"),
          input: {},
        });
        assert.deepEqual(failure, {
          content: [{ type: "text", text: "Could not complete" }],
          isError: true,
        });
        await assert.rejects(() =>
          Effect.runPromise(
            executor.tools.call({
              profile: firstProfile.id,
              app: first.id,
              tool: ToolName.make("queries.alpha"),
              input: {},
            }),
          ),
        );
        await assert.rejects(() =>
          Effect.runPromise(
            executor.tools.call({
              profile: firstProfile.id,
              app: first.id,
              tool: ToolName.make("queries.beta"),
              input: { value: "hello" },
            }),
          ),
        );
        assert.deepEqual(calls, ["alpha:alpha", "beta:beta", "alpha:failure"]);
        assert.equal(sessions.size, 0);
      },
      remote,
    );
  });
});

test("OAuth MCP imports declare host-owned discovery without connecting at build time", async () => {
  const remote: CatalogEntry = {
    ...entry,
    kind: "mcp",
    connectUrl: "https://mcp.axiom.co/mcp",
    auth: { kind: "oauth" },
  };
  await withServer(
    undefined,
    async (_engine, client) => {
      const app = await Effect.runPromise(
        client.dashboard.importApp({ payload: { entry: remote.id, name: "OAuth MCP" } }),
      );
      const method = app.requirements.accounts.service?.definition.auth.oauth;
      assert.ok(method?.type === "oauth2" && "discover" in method);
      assert.equal(method.discover, remote.connectUrl);
    },
    remote,
  );
  const generated = await Effect.runPromise(
    catalogFor(remote)
      .prepare({ entry: remote.id, mcpAuth: "apiKey" })
      .pipe(Effect.provide(NodeServices.layer)),
  );
  assert.ok(
    generated.files.some(
      (file) => file.path === "provider.ts" && file.content.includes("secrets("),
    ),
  );
});

test("PostHog catalog defaults use individual tools without duplicate rows or a new OAuth provider", async () => {
  const remote: CatalogEntry = {
    ...entry,
    id: "curated/posthog-com-mcp",
    kind: "mcp",
    name: "PostHog",
    connectUrl: "https://mcp.posthog.com/mcp?features=flags&mode=cli&mode=cli",
    auth: { kind: "oauth" },
  };
  await withServer(
    undefined,
    async (executor, client) => {
      const catalog = await Effect.runPromise(client.dashboard.catalog());
      assert.equal(catalog.length, 1);
      const effective = catalog[0];
      assert.ok(effective?.connectUrl);
      assert.equal(effective.id, remote.id);
      assert.equal(effective.oauthDiscoveryUrl, remote.connectUrl);
      const url = new URL(effective.connectUrl);
      assert.deepEqual(url.searchParams.getAll("mode"), ["tools"]);
      assert.equal(url.searchParams.get("features"), "flags");

      const previous = await Effect.runPromise(
        executor.apps.deploy({
          owner: OwnerId.make("local"),
          name: "Original definition",
          files: (
            await Effect.runPromise(
              catalogFor({ ...remote, id: "original-posthog" })
                .prepare({ entry: "original-posthog" })
                .pipe(Effect.provide(NodeServices.layer)),
            )
          ).files,
        }),
      );
      const app = await Effect.runPromise(
        client.dashboard.importApp({ payload: { entry: remote.id, name: "Catalog definition" } }),
      );
      assert.equal(
        app.requirements.accounts.service?.provider,
        previous.app.requirements.accounts.service?.provider,
      );
      const source = await Effect.runPromise(
        client.dashboard.source({
          params: { app: app.id, deployment: app.activeDeployment },
        }),
      );
      assert.ok(
        source.files
          .find((file) => file.path === "index.ts")
          ?.content.includes(JSON.stringify(effective.connectUrl)),
      );
      const method = app.requirements.accounts.service?.definition.auth.oauth;
      assert.ok(method?.type === "oauth2" && "discover" in method);
      assert.equal(method.discover, remote.connectUrl);
      assert.deepEqual(await Effect.runPromise(catalogFor(effective).list), [effective]);
    },
    remote,
  );
  for (const other of [
    { ...remote, id: "custom-posthog" },
    { ...remote, kind: "openapi" as const },
  ]) {
    assert.deepEqual(await Effect.runPromise(catalogFor(other).list), [other]);
  }
});

test("live OAuth advertisement supplements an API-key-only catalog entry", async () => {
  await withRemoteMcp(
    {
      unauthorized: true,
      authChallenge:
        'Bearer resource_metadata="https://service.example/.well-known/oauth-protected-resource"',
    },
    async ({ url }) => {
      const remote: CatalogEntry = {
        ...entry,
        kind: "mcp",
        connectUrl: url,
        auth: { kind: "api_key", header: "Authorization: Bearer {key}" },
      };
      await withServer(
        undefined,
        async (_engine, client) => {
          const app = await Effect.runPromise(
            client.dashboard.importApp({ payload: { entry: remote.id, name: "Both methods" } }),
          );
          const methods = app.requirements.accounts.service?.definition.auth;
          assert.equal(methods?.oauth?.type, "oauth2");
          assert.equal(methods?.apiKey?.type, "secrets");
          const source = await Effect.runPromise(
            client.dashboard.source({
              params: { app: app.id, deployment: app.activeDeployment },
            }),
          );
          assert.ok(
            source.files.some(
              (file) =>
                file.path === "index.ts" &&
                file.content.includes('accounts.service.method === "oauth"'),
            ),
          );
        },
        remote,
      );
      const explicit = await Effect.runPromise(
        catalogFor(remote)
          .prepare({ entry: remote.id, mcpAuth: "apiKey" })
          .pipe(Effect.provide(NodeServices.layer)),
      );
      assert.equal(
        explicit.files.some((file) => file.content.includes("oauth2({")),
        false,
      );
    },
  );
});

test("an authentication error without OAuth metadata does not invent an OAuth method", async () => {
  await withRemoteMcp(
    { unauthorized: true, authChallenge: 'Bearer realm="service"' },
    async ({ url }) => {
      const remote: CatalogEntry = { ...entry, kind: "mcp", connectUrl: url };
      await assert.rejects(
        () =>
          Effect.runPromise(
            catalogFor(remote)
              .prepare({ entry: remote.id })
              .pipe(Effect.provide(NodeServices.layer)),
          ),
        {
          _tag: "CatalogImportFailed",
          reason:
            "This MCP server requires authentication but did not advertise OAuth. Choose a sign-in method and try again.",
        },
      );
      const apiKey = await Effect.runPromise(
        catalogFor({ ...remote, auth: { kind: "api_key" } })
          .prepare({ entry: remote.id })
          .pipe(Effect.provide(NodeServices.layer)),
      );
      assert.equal(
        apiKey.files.some((file) => file.content.includes("oauth2({")),
        false,
      );
    },
  );
});

test("custom MCP URLs deploy source and connect through the same account flow", async () => {
  await withRemoteMcp({}, async ({ url, calls }) => {
    await withServer(undefined, async (executor, client) => {
      const app = await Effect.runPromise(
        client.dashboard.importCustomApp({
          payload: {
            source: {
              kind: "mcp",
              name: "Custom MCP",
              url,
              auth: { type: "apiKey", header: "Authorization", prefix: "Bearer " },
            },
          },
        }),
      );
      const appProfile = await Effect.runPromise(
        executor.apps.profiles.create({
          app: app.id,
          owner: app.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: {},
        }),
      );
      const provider = app.requirements.accounts.service?.provider;
      assert.ok(provider);
      const account = await Effect.runPromise(
        client.dashboard.addAccount({
          payload: {
            provider,
            method: "apiKey",
            label: "Custom account",
            fields: Redacted.make({ token: "alpha" }),
          },
        }),
      );
      await Effect.runPromise(
        client.profiles.update({
          params: { app: app.id, profile: appProfile.id },
          payload: {
            accounts: { service: account.id },
            expectedRevision: (
              await Effect.runPromise(
                executor.apps.profiles.get({ app: app.id, profile: appProfile.id }),
              )
            ).revision,
          },
        }),
      );
      const tools = await Effect.runPromise(
        executor.tools.list({ profile: appProfile.id, app: app.id }),
      );
      assert.ok(tools.items.some((tool) => tool.name === "queries.alpha"));
      await Effect.runPromise(
        executor.tools.call({
          profile: appProfile.id,
          app: app.id,
          tool: ToolName.make("queries.alpha"),
          input: { value: "custom" },
        }),
      );
      assert.deepEqual(calls, ["alpha:alpha"]);
      const source = await Effect.runPromise(
        client.dashboard.source({
          params: { app: app.id, deployment: app.activeDeployment },
        }),
      );
      assert.ok(
        source.files.some((file) => file.path === "index.ts" && file.content.includes(url)),
      );
      assert.equal(JSON.stringify(source.files).includes("alpha"), false);
      await assert.rejects(
        () =>
          Effect.runPromise(
            client.dashboard.importCustomApp({
              payload: {
                source: {
                  kind: "mcp",
                  name: "Custom MCP",
                  url,
                  auth: { type: "none" },
                },
              },
            }),
          ),
        { _tag: "AppNameTaken" },
      );
    });
  });
});

test("custom OpenAPI downloads YAML, resolves relative servers, and supports an explicit base URL", async () => {
  const paths: string[] = [];
  const upstream = createServer((request, response) => {
    if (request.url === "/openapi.yaml") {
      response.setHeader("content-type", "application/yaml");
      response.end(
        "openapi: 3.0.3\nservers:\n  - url: /api\npaths:\n  /ping:\n    get:\n      operationId: ping\n",
      );
    } else {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await withServer(undefined, async (executor, client) => {
      for (const [name, baseUrl] of [
        ["Relative", undefined],
        ["Override", base + "/override"],
      ] as const) {
        const app = await Effect.runPromise(
          client.dashboard.importCustomApp({
            payload: {
              source: {
                kind: "openapi",
                name,
                url: base + "/openapi.yaml",
                ...(baseUrl ? { baseUrl } : {}),
              },
            },
          }),
        );
        assert.deepEqual(app.requirements.accounts, {});
        assert.deepEqual(
          await completedCall(executor, {
            app: app.id,
            tool: ToolName.make("queries.ping"),
            input: {},
          }),
          { ok: true },
        );
      }
      assert.deepEqual(paths, ["/api/ping", "/override/ping"]);
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("custom GraphQL introspects with selected accounts and calls queries and mutations as app tools", async () => {
  const schema = buildSchema(`
    type Viewer { id: ID!, name: String!, nested: Viewer, needsArgument(id: ID!): String }
    input Filter { name: String!, child: Filter }
    type Query { viewer(filter: Filter): Viewer!, count: Int!, greet(name: String! = "world"): String! }
    type Mutation { rename(name: String!): Viewer! }
  `);
  const calls: string[] = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = Schema.decodeUnknownSync(
      Schema.Struct({ query: Schema.String, variables: Schema.Record(Schema.String, Schema.Json) }),
    )(JSON.parse(body));
    const account = request.headers["x-api-key"];
    if (account !== "alpha" && account !== "beta") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (!input.query.includes("IntrospectionQuery")) calls.push(account);
    const result = await graphql({
      schema,
      source: input.query,
      variableValues: input.variables,
      rootValue: {
        viewer: { id: account, name: "Example", nested: { id: "nested", name: "Nested" } },
        count: 3,
        greet: ({ name }: { name: string }) => "Hello " + name,
        rename: ({ name }: { name: string }) => ({ id: account, name }),
      },
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/graphql`;
  try {
    await withServer(undefined, async (executor, client) => {
      const first = await Effect.runPromise(
        client.dashboard.importCustomApp({
          payload: {
            source: {
              kind: "graphql",
              name: "Custom GraphQL",
              url,
              auth: { type: "apiKey", header: "X-API-Key", prefix: "" },
            },
          },
        }),
      );
      const firstProfile = await Effect.runPromise(
        executor.apps.profiles.create({
          app: first.id,
          owner: first.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: {},
        }),
      );
      const provider = first.requirements.accounts.service?.provider;
      assert.ok(provider);
      const second = await Effect.runPromise(
        executor.apps.copy({
          from: first.id,
          owner: OwnerId.make("local"),
          name: "Second GraphQL",
        }),
      );
      const secondProfile = await Effect.runPromise(
        executor.apps.profiles.create({
          app: second.id,
          owner: second.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: {},
        }),
      );
      for (const [app, token] of [
        [first, "alpha"],
        [second, "beta"],
      ] as const) {
        const account = await Effect.runPromise(
          client.dashboard.addAccount({
            payload: {
              provider,
              method: "apiKey",
              label: token,
              fields: Redacted.make({ token }),
            },
          }),
        );
        await Effect.runPromise(
          client.profiles.update({
            params: {
              app: app.id,
              profile: app.id === first.id ? firstProfile.id : secondProfile.id,
            },
            payload: {
              accounts: { service: account.id },
              expectedRevision: (
                await Effect.runPromise(
                  executor.apps.profiles.get({
                    app: app.id,
                    profile: app.id === first.id ? firstProfile.id : secondProfile.id,
                  }),
                )
              ).revision,
            },
          }),
        );
        const tools = await Effect.runPromise(
          executor.tools.list({
            profile: app.id === first.id ? firstProfile.id : secondProfile.id,
            app: app.id,
          }),
        );
        assert.equal(tools.items.length, 4);
        assert.equal(
          tools.items.find((tool) => tool.name === "queries.query_viewer")?.readOnly,
          true,
        );
        assert.equal(
          tools.items.find((tool) => tool.name === "mutations.mutation_rename")?.readOnly,
          false,
        );
        assert.deepEqual(
          await completedCall(executor, {
            profile: app.id === first.id ? firstProfile.id : secondProfile.id,
            app: app.id,
            tool: ToolName.make("queries.query_viewer"),
            input: {},
          }),
          { id: token, name: "Example" },
        );
      }
      const invoke = (tool: string, input: Schema.Json) =>
        completedCall(executor, {
          profile: firstProfile.id,
          app: first.id,
          tool: ToolName.make(`${tool.startsWith("query_") ? "queries" : "mutations"}.${tool}`),
          input,
        });
      assert.equal(await invoke("query_count", {}), 3);
      assert.equal(await invoke("query_greet", {}), "Hello world");
      assert.deepEqual(
        await invoke("query_viewer", {
          arguments: { filter: { name: "a", child: { name: "b" } } },
          select: "id nested { id }",
        }),
        { id: "alpha", nested: { id: "nested" } },
      );
      assert.deepEqual(await invoke("mutation_rename", { arguments: { name: "Updated" } }), {
        id: "alpha",
        name: "Updated",
      });
      const beforeInvalid = calls.length;
      await assert.rejects(() => invoke("mutation_rename", {}));
      await assert.rejects(() =>
        invoke("query_viewer", {
          select: 'id } count } mutation { rename(name: "bad") { id } } query { result { id',
        }),
      );
      await assert.rejects(() =>
        invoke("query_viewer", {
          arguments: { filter: { child: { name: "missing parent name" } } },
        }),
      );
      assert.equal(calls.length, beforeInvalid);
      const source = await Effect.runPromise(
        client.dashboard.source({
          params: { app: first.id, deployment: first.activeDeployment },
        }),
      );
      assert.ok(
        source.files.some(
          (file) => file.path === "index.ts" && file.content.includes("graphqlOperations"),
        ),
      );
      assert.equal(JSON.stringify(source.files).includes("alpha"), false);
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

/** Consume transport snapshots in order; a hung subscription is a test failure, never a successful empty result. */
const observeValues = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const values = yield* Queue.unbounded<A, E>();
    yield* stream.pipe(
      Stream.runForEach((value) => Queue.offer(values, value)),
      Effect.catchCause((cause) => Queue.failCause(values, cause)),
      Effect.forkScoped,
    );
    return (matches: (value: A) => boolean = () => true) =>
      Effect.gen(function* () {
        while (true) {
          const value = yield* Queue.take(values);
          if (matches(value)) return value;
        }
      }).pipe(Effect.timeout("10 seconds"));
  });

const observe = <A, Q, E>(
  stream: Stream.Stream<
    | { readonly type: "snapshot"; readonly value: A }
    | { readonly type: "failure"; readonly error: Q }
    | { readonly type: "heartbeat" },
    E
  >,
) =>
  observeValues(
    stream.pipe(
      Stream.filter((frame) => frame.type !== "heartbeat"),
      Stream.mapEffect((frame) =>
        frame.type === "snapshot" ? Effect.succeed(frame.value) : Effect.fail(frame.error),
      ),
    ),
  );

test(
  "live dashboard follows SDK commits, credential replacement and deployments without unrelated tool discovery",
  { timeout: 60_000 },
  async () => {
    let discoveryRequests = 0;
    await withRemoteMcp(
      {
        onList: () => {
          discoveryRequests += 1;
        },
      },
      async ({ url }) => {
        const remote: CatalogEntry = {
          ...entry,
          kind: "mcp",
          connectUrl: url,
          auth: { kind: "api_key" },
        };
        await withServer(
          undefined,
          async (executor, client) => {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const first = yield* client.dashboard.importApp({
                    payload: { entry: remote.id, name: "Live app" },
                  });
                  const firstProfile = yield* executor.apps.profiles.create({
                    app: first.id,
                    owner: first.owner,
                    subject: "local",
                    idempotencyKey: "test",
                    accounts: {},
                  });
                  const provider = first.requirements.accounts.service?.provider;
                  assert.ok(provider);
                  const account = yield* executor.accounts.add({
                    owner: OwnerId.make("local"),
                    provider,
                    method: "apiKey",
                    label: "First",
                    fields: Redacted.make({ token: "alpha" }),
                  });
                  yield* executor.apps.profiles.update({
                    app: first.id,
                    profile: firstProfile.id,
                    accounts: { service: account.id },
                    expectedRevision: (yield* executor.apps.profiles.get({
                      app: first.id,
                      profile: firstProfile.id,
                    })).revision,
                  });
                  const overview = yield* observe(yield* client.dashboard.liveOverview());
                  const app = yield* observe(
                    yield* client.dashboard.liveApp({ params: { app: first.id } }),
                  );
                  const detail = yield* observe(
                    yield* client.dashboard.liveAccount({ params: { account: account.id } }),
                  );
                  const tools = yield* observe(
                    yield* client.dashboard.liveTools({
                      query: { profile: firstProfile.id },
                      params: { app: first.id },
                    }),
                  );
                  assert.equal((yield* overview()).apps.length, 1);
                  assert.equal((yield* app()).app.activeDeployment, first.activeDeployment);
                  assert.equal((yield* detail()).account.label, "First");
                  assert.ok((yield* tools()).tools.some((tool) => tool.name === "queries.alpha"));
                  const initialDiscovery = discoveryRequests;

                  // External writes pass through the SDK, not dashboard mutation handlers.
                  const unrelated = yield* executor.accounts.add({
                    owner: OwnerId.make("local"),
                    provider,
                    method: "apiKey",
                    label: "Other",
                    fields: Redacted.make({ token: "other" }),
                  });
                  assert.ok(
                    (yield* overview((value) =>
                      value.accounts.some((item) => item.id === unrelated.id),
                    )).accounts.length === 2,
                  );
                  yield* executor.accounts.update({
                    account: account.id,
                    label: "Renamed from SDK",
                  });
                  assert.equal(
                    (yield* detail((value) => value.account.label === "Renamed from SDK")).account
                      .label,
                    "Renamed from SDK",
                  );
                  assert.equal(
                    discoveryRequests,
                    initialDiscovery,
                    "metadata and unrelated credentials must not rediscover upstream tools",
                  );

                  yield* executor.accounts.replaceCredentials({
                    account: account.id,
                    fields: Redacted.make({ token: "beta" }),
                  });
                  const changed = yield* tools((value) =>
                    value.tools.some((tool) => tool.name === "queries.beta"),
                  );
                  assert.ok(!JSON.stringify(changed).includes("encryptedCredentials"));
                  assert.ok(discoveryRequests > initialDiscovery);

                  const retained = yield* client.dashboard.source({
                    params: { app: first.id, deployment: first.activeDeployment },
                  });
                  const deployed = yield* executor.apps.deploy({
                    owner: first.owner,
                    app: first.id,
                    files: retained.files,
                  });
                  assert.equal(
                    (yield* app((value) => value.app.activeDeployment === deployed.deployment.id))
                      .deployments.length,
                    2,
                  );
                  assert.ok(
                    (yield* tools((value) =>
                      value.tools.every((tool) => tool.deployment === deployed.deployment.id),
                    )).tools.length > 0,
                  );
                  // A fresh subscription starts from current state instead of replaying old mutations.
                  const reconnected = yield* observe(
                    yield* client.dashboard.liveApp({ params: { app: first.id } }),
                  );
                  assert.equal((yield* reconnected()).app.activeDeployment, deployed.deployment.id);
                }),
              ),
            );
          },
          remote,
        );
      },
    );
  },
);

test(
  "revoking a browser session stops live snapshots before delivering the next storage change",
  { timeout: 30_000 },
  async () => {
    await withServer(
      spec("https://api.example.test"),
      async (executor, client, { auth, url, port }) => {
        const first = await Effect.runPromise(
          client.dashboard.importApp({ payload: { entry: entry.id, name: "Session fixture" } }),
        );
        const session = await Effect.runPromise(
          auth.issue().pipe(Effect.flatMap((grant) => auth.exchange(grant.token))),
        );
        const browser = await reader(url, {
          cookie: `${sessionCookie({ port })}=${Redacted.value(session)}`,
        });
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const next = yield* observe(yield* browser.dashboard.liveOverview());
              assert.equal((yield* next()).apps.length, 1);
              yield* auth.revoke(Redacted.value(session));
              yield* executor.apps.copy({
                from: first.id,
                owner: first.owner,
                name: "After revoke",
              });
              assert.equal((yield* Effect.flip(next()))._tag, "DashboardUnauthorized");
            }),
          ),
        );
      },
    );
  },
);

test(
  "live tools keep their subscription through missing-account errors and recover after an SDK selection",
  { timeout: 30_000 },
  async () => {
    await withServer(spec("https://api.example.test"), async (executor, client) => {
      const first = await Effect.runPromise(
        client.dashboard.importApp({ payload: { entry: entry.id, name: "Recovery fixture" } }),
      );
      const firstProfile = await Effect.runPromise(
        executor.apps.profiles.create({
          app: first.id,
          owner: first.owner,
          subject: "local",
          idempotencyKey: "test",
          accounts: {},
        }),
      );
      const provider = first.requirements.accounts.service?.provider;
      assert.ok(provider);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const next = yield* observeValues(
              (yield* client.dashboard.liveTools({
                query: { profile: firstProfile.id },
                params: { app: first.id },
              })).pipe(Stream.filter((frame) => frame.type !== "heartbeat")),
            );
            const failed = yield* next();
            assert.equal(failed.type, "failure");
            if (failed.type === "failure") assert.equal(failed.error._tag, "AccountRequired");
            const account = yield* executor.accounts.add({
              owner: first.owner,
              provider,
              method: "apiKey",
              label: "Connected elsewhere",
              fields: Redacted.make({ token: "synthetic" }),
            });
            yield* executor.apps.profiles.update({
              app: first.id,
              profile: firstProfile.id,
              accounts: { service: account.id },
              expectedRevision: (yield* executor.apps.profiles.get({
                app: first.id,
                profile: firstProfile.id,
              })).revision,
            });
            const recovered = yield* next((frame) => frame.type === "snapshot");
            assert.equal(recovered.type, "snapshot");
            if (recovered.type === "snapshot") assert.ok(recovered.value.tools.length > 0);
            yield* executor.apps.profiles.update({
              app: first.id,
              profile: firstProfile.id,
              accounts: {},
              expectedRevision: (yield* executor.apps.profiles.get({
                app: first.id,
                profile: firstProfile.id,
              })).revision,
            });
            const disconnected = yield* next((frame) => frame.type === "failure");
            assert.equal(disconnected.type, "failure");
            yield* executor.apps.profiles.update({
              app: first.id,
              profile: firstProfile.id,
              accounts: { service: account.id },
              expectedRevision: (yield* executor.apps.profiles.get({
                app: first.id,
                profile: firstProfile.id,
              })).revision,
            });
            assert.equal((yield* next((frame) => frame.type === "snapshot")).type, "snapshot");
          }),
        ),
      );
    });
  },
);

test("the local dashboard renames apps without changing URLs, accounts or deployments", async () => {
  await withServer(spec("https://api.example.test"), async (executor, client) => {
    const app = await Effect.runPromise(
      client.dashboard.importApp({ payload: { entry: entry.id, name: "Rename fixture" } }),
    );
    const renamed = await Effect.runPromise(
      client.dashboard.renameApp({ params: { app: app.id }, payload: { name: "Renamed locally" } }),
    );
    const { skippedOperations: _skipped, ...imported } = app;
    assert.deepEqual(renamed, { ...imported, name: "Renamed locally", slug: "renamed-locally" });
    assert.equal(
      (await Effect.runPromise(client.dashboard.app({ params: { app: app.id } }))).app.name,
      "Renamed locally",
    );
    assert.equal(
      (await Effect.runPromise(executor.apps.get({ app: app.id }))).activeDeployment,
      app.activeDeployment,
    );
  });
});
