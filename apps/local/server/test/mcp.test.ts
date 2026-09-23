import { ExecutorApi, OwnerId } from "@executor-js/sdk/core";
/** Real MCP client and HTTP sockets; each run owns an isolated database and server lifecycle. */
import { telemetryLayer } from "@executor-js/telemetry";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ElicitRequestSchema,
  ElicitRequestParamsSchema,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, FileSystem, Layer, ManagedRuntime, Path, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { DashboardApi } from "../src/contracts/dashboard.ts";
import { AccountConnection } from "@executor-js/sdk";
import { AccountConnectionLink } from "../src/contracts/account-connections.ts";
import { AppId, DeploymentId } from "@executor-js/sdk";
import { localManagementDocument } from "../src/contracts/management.ts";
import { ServerConfig } from "../src/contracts/config.ts";
import {
  ExecuteResult,
  BrowserExecutionResult,
  McpExecutionResult,
  SearchResult,
  defaultMcpLimits,
  type McpLimits,
  SkillDocument,
  SkillsResult,
} from "@executor-js/mcp";
import { localApi } from "../src/implementation/server.ts";
import { withElicitingMcp } from "./fixtures/eliciting-mcp.ts";

const apiKey = "synthetic-mcp-test-bearer-000000000000";
const encryptionKey = "ab".repeat(32);
const App = Schema.Struct({
  id: AppId,
  slug: Schema.String,
  code: Schema.String,
  activeDeployment: DeploymentId,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
});
const Account = Schema.Struct({ id: Schema.String });
const Search = Schema.Struct({
  items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
});
const Identity = Schema.Struct({ account: Schema.String, identity: Schema.String });
const decodeResult = Schema.decodeUnknownSync(ExecuteResult);

async function start(
  directory: string,
  limits: McpLimits = defaultMcpLimits,
  tracing?: { readonly url: string; readonly parent: string },
) {
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(
      Layer.unwrap(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          assert.equal(server.address._tag, "InetAddressV4");
          if (server.address._tag !== "InetAddressV4") throw new Error("TCP listener required");
          const settings = Schema.decodeUnknownSync(ServerConfig)({
            directory,
            port: server.address.port,
            apiKey,
            encryptionKey,
            mcp: limits,
          });
          return localApi(settings, globalThis.crypto);
        }),
      ),
      { disableLogger: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        tracing === undefined
          ? Layer.empty
          : telemetryLayer(
              {
                service: "mcp-proof",
                version: "test",
                environment: "test",
                traces: { url: tracing.url },
              },
              "event",
            ),
      ),
    ),
  );
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer);
    if (server.address._tag !== "InetAddressV4") throw new Error("TCP listener required");
    const url = new URL(`http://127.0.0.1:${server.address.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(tracing === undefined ? {} : { traceparent: tracing.parent }),
        },
      },
    });
    const client = new Client({ name: "executor-integration-test", version: "1" });
    // The SDK types sessionId as optional on Transport but as a getter returning undefined here.
    const clientTransport: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
    try {
      await client.connect(clientTransport);
    } catch (error) {
      await client.close();
      throw error;
    }
    return {
      client,
      transport,
      url,
      close: async () => {
        try {
          await client.close();
        } finally {
          await runtime.dispose();
        }
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

type Server = Awaited<ReturnType<typeof start>>;
async function execute(server: Server, code: string) {
  const response = await server.client.callTool({ name: "execute", arguments: { code } });
  assert.notEqual(response.isError, true, "MCP envelope failed");
  return decodeResult(response.structuredContent);
}
async function value(server: Server, code: string) {
  const result = await execute(server, code);
  assert.equal(result.execution.ok, true, JSON.stringify(result.execution));
  return result.execution.value;
}
const call = (path: string, input: unknown) => `return await ${path}(${JSON.stringify(input)})`;
const appPath = (slug: string, profile?: string) => {
  const app = /^[a-z][a-z0-9]*$/.test(slug) ? `tools.${slug}` : `tools[${JSON.stringify(slug)}]`;
  return profile === undefined ? app : `${app}.profiles[${JSON.stringify(profile)}]`;
};

const reader = (server: Server, token = apiKey, origin = server.url.origin) =>
  Effect.runPromise(
    HttpApiClient.make(DashboardApi, {
      baseUrl: server.url.origin,
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${token}`,
              origin,
            }),
          ),
        ),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

async function verify(directory: string, source: string) {
  let server = await start(directory);
  try {
    const advertised = (await server.client.listTools()).tools;
    assert.deepEqual(advertised.map((tool) => tool.name).sort(), ["execute", "resume", "skills"]);
    assert.equal(
      advertised.find((tool) => tool.name === "skills")?.annotations?.readOnlyHint,
      true,
    );
    const index = await server.client.callTool({ name: "skills", arguments: {} });
    const listedSkills = Schema.decodeUnknownSync(SkillsResult)(index.structuredContent);
    assert.ok("skills" in listedSkills);
    const guide = listedSkills.skills.find(
      (skill) => skill.name === "app-authoring" && skill.app.slug === "executor",
    );
    assert.ok(guide);
    const document = await server.client.callTool({
      name: "skills",
      arguments: { app: guide.app.slug, name: guide.name },
    });
    const skill = Schema.decodeUnknownSync(SkillDocument)(document.structuredContent);
    const example = skill.content.match(/```ts\n([\s\S]*?)\n```/)?.[1];
    assert.ok(example, "The served skill must include a runnable app");
    assert.equal(
      (await server.client.callTool({ name: "skills", arguments: { name: "../not-a-skill" } }))
        .isError,
      true,
    );
    const discovery = Schema.decodeUnknownSync(Search)(
      await value(
        server,
        `const items = []; let offset = 0; while (true) {
        const page = await tools.search({ query: "Executor", limit: 25, offset });
        items.push(...page.items.map(({ path, signature }) => ({ path, signature })));
        if (page.next === null) return { items };
        offset = page.next.offset;
      }`,
      ),
    );
    const deployTool = discovery.items.find((item) => item.path.endsWith(".mutations.apps_deploy"));
    assert.ok(deployTool);
    const executor = deployTool.path.slice(0, -".mutations.apps_deploy".length);
    assert.match(
      discovery.items.find((item) => item.path.endsWith(".mutations.accounts_add"))?.signature ??
        "",
      /\[key: string\]/,
    );
    const openapi = await fetch(new URL("/openapi.json", server.url), {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(openapi.status, 200);
    assert.deepEqual(await openapi.json(), localManagementDocument());
    for (const privateOperation of ["tools_resume", "webhookSetup_read", "accountConnect_submit"]) {
      assert.ok(!discovery.items.some((item) => item.path.endsWith(`.${privateOperation}`)));
    }

    const draft = Schema.decodeUnknownSync(
      Schema.Struct({ id: AppId, activeDeployment: Schema.Null }),
    )(
      await value(
        server,
        call(`${executor}.mutations.appManagement_create`, {
          body: { name: "Agent draft", files: [{ path: "index.ts", content: example }] },
        }),
      ),
    );
    assert.equal(
      (await execute(server, "return 1")).unavailableApps.find((app) => app.app === draft.id)
        ?.reason,
      "AppNotDeployed",
    );
    const sourceView = Schema.Struct({
      revision: Schema.Struct({ commit: Schema.String }),
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    });
    const initialSource = Schema.decodeUnknownSync(sourceView)(
      await value(
        server,
        call(`${executor}.queries.appManagement_source`, { path: { app: draft.id } }),
      ),
    );
    const committedSource = Schema.decodeUnknownSync(sourceView)(
      await value(
        server,
        call(`${executor}.mutations.appManagement_commit`, {
          path: { app: draft.id },
          body: {
            expected: initialSource.revision.commit,
            files: [
              ...initialSource.files,
              { path: "README.md", content: "Edited by a connected agent." },
            ],
            message: "Add documentation",
          },
        }),
      ),
    );
    assert.notEqual(committedSource.revision.commit, initialSource.revision.commit);
    const deployedDraft = Schema.decodeUnknownSync(
      Schema.Struct({ app: Schema.Struct({ id: AppId, activeDeployment: DeploymentId }) }),
    )(
      await value(
        server,
        call(`${executor}.mutations.appManagement_deploy`, {
          path: { app: draft.id },
          body: { commit: committedSource.revision.commit },
        }),
      ),
    );
    assert.equal(deployedDraft.app.id, draft.id);

    // Deploy the exact source delivered through the skills tool, then call it through MCP.
    const documented = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
      await value(
        server,
        call(`${executor}.mutations.apps_deploy`, {
          body: {
            owner: "mcp-test",
            name: "Documented hello",
            files: [{ path: "index.ts", content: example }],
          },
        }),
      ),
    );
    assert.deepEqual(
      await value(server, call(`${appPath(documented.app.slug)}.queries.greet`, { name: "Ada" })),
      { message: "Hello, Ada!" },
    );
    assert.deepEqual(
      await value(server, call(`${appPath(documented.app.slug)}.queries.greet`, {})),
      {
        message: "Hello, world!",
      },
    );

    // The generated deploy schema also supports updates by stable ID, absent from the old wrapper.
    const updated = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
      await value(
        server,
        call(`${executor}.mutations.apps_deploy`, {
          body: {
            owner: "mcp-test",
            app: documented.app.id,
            expectedDeployment: documented.app.activeDeployment,
            files: [{ path: "index.ts", content: example }],
          },
        }),
      ),
    );
    assert.equal(updated.app.id, documented.app.id);
    assert.notEqual(updated.app.activeDeployment, documented.app.activeDeployment);
    const retained = await value(
      server,
      call(`${executor}.queries.apps_source`, {
        path: { app: documented.app.id },
        query: { deployment: updated.app.activeDeployment },
      }),
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(
        Schema.Struct({
          files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
        }),
      )(retained).files,
      [{ path: "index.ts", content: example }],
    );

    const deployed = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
      await value(
        server,
        call(`${executor}.mutations.apps_deploy`, {
          body: {
            owner: "mcp-test",
            name: "First",
            files: [{ path: "index.ts", content: source }],
          },
        }),
      ),
    );
    const first = deployed.app;
    const sdk = await Effect.runPromise(
      HttpApiClient.make(ExecutorApi, {
        baseUrl: server.url.origin,
        transformClient: (client) =>
          client.pipe(
            HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`)),
          ),
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    assert.deepEqual(
      await Effect.runPromise(sdk.apps.list({ query: { ids: [] } })),
      [],
      "empty IDs must survive HTTP encoding",
    );
    assert.deepEqual(
      (
        await Effect.runPromise(sdk.apps.list({ query: { ids: [AppId.make(documented.app.id)] } }))
      ).map((app) => app.id),
      [documented.app.id],
    );
    assert.deepEqual(
      await Effect.runPromise(
        sdk.apps.list({
          query: { ids: [AppId.make(documented.app.id)], owner: OwnerId.make("other") },
        }),
      ),
      [],
    );
    const firstProfile = await Effect.runPromise(
      sdk.appProfiles.create({
        params: { app: first.id },
        payload: {
          owner: OwnerId.make("mcp-test"),
          subject: "local",
          accounts: {},
          idempotencyKey: "first",
        },
      }),
    );
    const provider = first.requirements.accounts.service?.provider;
    assert.ok(provider);
    const incomplete = await execute(server, "return 1");
    assert.equal(
      incomplete.unavailableApps.find((app) => app.app === first.id)?.reason,
      "AccountRequired",
    );

    const link = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnectionLink))(
      await value(
        server,
        call(`${executor}.mutations.accountConnect_issue`, {
          body: {
            owner: "alice",
            target: { app: first.id, profile: firstProfile.id, requirement: "service" },
          },
        }),
      ),
    );
    const connectionUrl = new URL(Redacted.value(link.url));
    assert.equal(connectionUrl.pathname, `/account-connect/${link.connection}`);
    const token = new URLSearchParams(connectionUrl.hash.slice(1)).get("token");
    assert.ok(token);
    const grant = { connection: link.connection, token };
    const browserPost = (path: string, body: unknown, origin = server.url.origin) =>
      fetch(`${server.url.origin}/account-connect/api/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });
    const pending = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(
      await value(
        server,
        call(`${executor}.queries.accountConnections_get`, {
          path: { connection: link.connection },
        }),
      ),
    );
    assert.equal(pending.state.status, "pending");
    assert.deepEqual(pending.target, {
      app: first.id,
      profile: firstProfile.id,
      requirement: "service",
      name: "First",
    });
    for (const [body, origin, expected] of [
      [grant, "https://foreign.example", 403],
      [{ ...grant, token: "00".repeat(32) }, server.url.origin, 401],
      [{ ...grant, connection: "con_other" }, server.url.origin, 401],
    ] as const) {
      const response = await browserPost("read", body, origin);
      assert.equal(response.status, expected);
      await response.body?.cancel();
    }
    const dashboard = await fetch(`${server.url.origin}/dashboard/api/overview`, {
      headers: { authorization: `Bearer ${token}`, origin: server.url.origin },
    });
    assert.equal(dashboard.status, 401);
    await dashboard.body?.cancel();
    const form = await browserPost("read", grant);
    assert.equal(form.status, 200);
    assert.equal(form.headers.get("cache-control"), "no-store");
    const formMetadata = await form.text();
    assert.ok(formMetadata.includes("apiKey"));
    assert.ok(!formMetadata.includes(apiKey));
    const submitted = {
      ...grant,
      method: "apiKey",
      label: "First account",
      fields: { token: "synthetic-first-key" },
    };
    const submission = await browserPost("submit", submitted);
    assert.equal(submission.status, 200);
    const accountA = Schema.decodeUnknownSync(Account)(await submission.json());
    const retry = await browserPost("submit", submitted);
    assert.equal(retry.status, 200);
    assert.deepEqual(Schema.decodeUnknownSync(Account)(await retry.json()), accountA);
    const completed = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(
      await value(
        server,
        call(`${executor}.queries.accountConnections_get`, {
          path: { connection: link.connection },
        }),
      ),
    );
    assert.equal(completed.state.status, "completed");
    if (completed.state.status === "completed")
      assert.equal(completed.state.account.id, accountA.id);
    assert.ok(!JSON.stringify(completed).includes("synthetic-first-key"));
    assert.deepEqual(
      Schema.decodeUnknownSync(
        Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.String) }),
      )(
        await value(
          server,
          call(`${executor}.queries.appProfiles_get`, {
            path: { app: first.id, profile: firstProfile.id },
          }),
        ),
      ).accounts,
      { service: accountA.id },
    );
    // Manual webhook setup is generated too; its private form remains outside agent discovery.
    const subscription = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, status: Schema.String }),
    )(
      await value(
        server,
        call(`${executor}.mutations.webhooks_create`, {
          path: { app: first.id },
          body: { profile: firstProfile.id, key: "events", name: "events", config: {} },
        }),
      ),
    );
    assert.equal(subscription.status, "setup-required");
    const webhookTarget = { app: first.id, subscription: subscription.id };
    const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
      await value(server, call(`${executor}.queries.webhookLinks_link`, { path: webhookTarget })),
    );
    assert.equal(new URL(setup.url).pathname, `/webhooks/${first.id}/${subscription.id}`);
    await value(server, call(`${executor}.mutations.webhooks_remove`, { path: webhookTarget }));
    await value(
      server,
      call(`${executor}.mutations.webhooks_confirmRemoval`, { path: webhookTarget }),
    );

    const second = Schema.decodeUnknownSync(App)(
      await value(
        server,
        call(`${executor}.mutations.apps_copy`, {
          body: { from: first.id, owner: "mcp-test", name: "Second" },
        }),
      ),
    );
    const secondProfile = await Effect.runPromise(
      sdk.appProfiles.create({
        params: { app: second.id },
        payload: {
          owner: OwnerId.make("mcp-test"),
          subject: "local",
          accounts: {},
          idempotencyKey: "second",
        },
      }),
    );
    assert.notEqual(second.code, first.code);
    assert.notEqual(second.activeDeployment, first.activeDeployment);
    const standalone = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnectionLink))(
      await value(
        server,
        call(`${executor}.mutations.accountConnect_issue`, { body: { owner: "bob", provider } }),
      ),
    );
    const standaloneToken = new URLSearchParams(
      new URL(Redacted.value(standalone.url)).hash.slice(1),
    ).get("token");
    const standaloneSubmission = await browserPost("submit", {
      connection: standalone.connection,
      token: standaloneToken,
      method: "apiKey",
      label: "Second account",
      fields: { token: "synthetic-second-key" },
    });
    assert.equal(standaloneSubmission.status, 200);
    const accountB = Schema.decodeUnknownSync(Account)(await standaloneSubmission.json());
    const standaloneResult = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(
      await value(
        server,
        call(`${executor}.queries.accountConnections_get`, {
          path: { connection: standalone.connection },
        }),
      ),
    );
    assert.equal(standaloneResult.target, null);
    assert.equal(standaloneResult.state.status, "completed");
    assert.deepEqual(
      Schema.decodeUnknownSync(
        Schema.Struct({ accounts: Schema.Record(Schema.String, Schema.String) }),
      )(
        await value(
          server,
          call(`${executor}.queries.appProfiles_get`, {
            path: { app: second.id, profile: secondProfile.id },
          }),
        ),
      ).accounts,
      {},
    );
    await value(
      server,
      call(`${executor}.mutations.appProfiles_update`, {
        path: { app: second.id, profile: secondProfile.id },
        body: {
          expectedRevision: (
            await Effect.runPromise(
              sdk.appProfiles.get({
                params: { app: second.id, profile: secondProfile.id },
                query: {},
              }),
            )
          ).revision,
          accounts: { service: accountB.id },
        },
      }),
    );
    const program = `return await Promise.all([${appPath(first.slug, firstProfile.id)}.mutations.identify({message: "hello"}), ${appPath(second.slug, secondProfile.id)}.mutations.identify({message: "hello"})])`;
    const expected = [
      { account: accountA.id, identity: "first" },
      { account: accountB.id, identity: "second" },
    ];
    assert.deepEqual(
      Schema.decodeUnknownSync(Schema.Array(Identity))(await value(server, program)),
      expected,
    );
    assert.equal(
      (
        await execute(
          server,
          call(`${appPath(first.slug, firstProfile.id)}.mutations.page99`, {
            message: "last page",
          }),
        )
      ).execution.ok,
      true,
    );
    const dynamic = Schema.decodeUnknownSync(Search)(
      await value(server, 'return await tools.search({ query: "secondOnly" })'),
    );
    assert.ok(
      dynamic.items.some(
        (tool) => tool.path === `${appPath(second.slug, secondProfile.id)}.mutations.secondOnly`,
      ),
    );
    assert.ok(
      !dynamic.items.some(
        (tool) => tool.path === `${appPath(first.slug, firstProfile.id)}.mutations.secondOnly`,
      ),
    );
    const firstPage = Schema.decodeUnknownSync(SearchResult)(
      await value(server, "return await tools.search({ limit: 1 })"),
    );
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.next);
    const nextPage = Schema.decodeUnknownSync(SearchResult)(
      await value(
        server,
        `return await tools.search({ limit: 1, offset: ${firstPage.next.offset} })`,
      ),
    );
    assert.notEqual(firstPage.items[0]?.path, nextPage.items[0]?.path);
    assert.equal(nextPage.remaining, firstPage.remaining - 1);
    const metadata = await value(server, call(`${executor}.queries.accounts_list`, {}));
    assert.ok(!JSON.stringify(metadata).includes("synthetic-first-key"));
    assert.ok(!JSON.stringify(metadata).includes(apiKey));

    const read = await reader(server);
    const inventory = await Effect.runPromise(read.dashboard.overview());
    const managed = inventory.apps.find(
      (app) => app.owner === "executor-local" && app.name === "Executor",
    );
    assert.ok(managed);
    assert.equal(
      (await Effect.runPromise(read.dashboard.app({ params: { app: managed.id } }))).canDelete,
      false,
    );
    assert.equal(
      (
        await Effect.runPromise(
          Effect.flip(read.dashboard.deleteApp({ params: { app: managed.id } })),
        )
      )._tag,
      "AppDeletionBlocked",
    );
    for (const id of [managed.id, managed.id.replace("app_", "%61pp_")]) {
      const blocked = await fetch(new URL(`/v1/apps/${id}`, server.url), {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(blocked.status, 403);
      await blocked.body?.cancel();
    }
    const renameManaged = await fetch(new URL(`/v1/apps/${managed.id}/name`, server.url), {
      method: "PATCH",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Executor" }),
    });
    assert.equal(renameManaged.status, 403);
    await renameManaged.body?.cancel();
    const managedProfile = inventory.profiles.find((profile) => profile.app === managed.id);
    assert.ok(managedProfile);
    const managedAccount = managedProfile.accounts.executor;
    assert.ok(typeof managedAccount === "string");
    const params = { account: managedAccount };
    assert.equal((await Effect.runPromise(read.dashboard.account({ params }))).canManage, false);
    const managedMutations: readonly Effect.Effect<unknown, { readonly _tag: string }>[] = [
      read.dashboard.renameAccount({ params, payload: { label: "Changed" } }),
      read.dashboard.replaceAccountCredentials({ params, payload: { fields: Redacted.make({}) } }),
      read.dashboard.reconnectAccount({ params, payload: {} }),
      read.dashboard.disconnectAccount({ params }),
    ];
    for (const mutation of managedMutations)
      assert.equal(
        (await Effect.runPromise(Effect.flip(mutation)))._tag,
        "AccountManagementBlocked",
      );
    for (const id of [managedAccount, managedAccount.replace("acc_", "%61cc_")]) {
      for (const [method, suffix] of [
        ["DELETE", ""],
        ["PATCH", ""],
        ["PUT", "/credentials"],
      ] as const) {
        const blocked = await fetch(new URL(`/v1/accounts/${id}${suffix}`, server.url), {
          method,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        assert.equal(blocked.status, 403);
        await blocked.body?.cancel();
      }
    }
    const protectedConnection = await fetch(new URL("/v1/account-connections", server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        owner: "executor-local",
        provider: managed.requirements.accounts.executor?.provider,
        account: managedAccount,
      }),
    });
    assert.equal(protectedConnection.status, 404);
    await protectedConnection.body?.cancel();
    for (const [path, expected] of [
      ["/v1/account-connections", 404],
      ["/account-connect/api/requests", 401],
    ] as const) {
      const blocked: Response = await fetch(new URL(path, server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          owner: "executor-local",
          target: { app: managed.id, profile: managedProfile.id, requirement: "executor" },
        }),
      });
      assert.equal(blocked.status, expected);
      await blocked.body?.cancel();
    }
    for (const destination of [
      {},
      { provider, target: { app: first.id, profile: firstProfile.id, requirement: "service" } },
    ]) {
      const invalid = await fetch(new URL("/v1/account-connections", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: "alice", ...destination }),
      });
      assert.equal(invalid.status, 400);
      await invalid.body?.cancel();
    }
    const oldOAuth = await fetch(new URL("/v1/accounts/oauth/start", server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(oldOAuth.status, 404);
    await oldOAuth.body?.cancel();
    assert.ok(inventory.apps.some((app) => app.id === first.id));
    assert.equal(
      inventory.accounts.find((account) => account.id === accountA.id)?.providerName,
      "MCP test service",
    );
    assert.ok(!JSON.stringify(inventory).includes("synthetic-first-key"));
    const detail = await Effect.runPromise(read.dashboard.app({ params: { app: first.id } }));
    assert.ok(detail.deployments.some((deployment) => deployment.id === first.activeDeployment));
    const sourceRead = await Effect.runPromise(
      read.dashboard.source({ params: { app: first.id, deployment: first.activeDeployment } }),
    );
    assert.equal(sourceRead.files[0]?.content, source);
    const wrongLineage = await Effect.runPromise(
      Effect.flip(
        read.dashboard.source({
          params: {
            app: first.id,
            deployment: documented.app.activeDeployment,
          },
        }),
      ),
    );
    assert.equal(wrongLineage._tag, "DeploymentNotFound");
    const unauthenticated = await reader(server, "wrong-key");
    assert.equal(
      (await Effect.runPromise(Effect.flip(unauthenticated.dashboard.overview())))._tag,
      "DashboardUnauthorized",
    );
    const foreignOrigin = await reader(server, apiKey, "https://example.com");
    assert.equal(
      (await Effect.runPromise(Effect.flip(foreignOrigin.dashboard.overview())))._tag,
      "DashboardForbidden",
    );

    // The account and retained build survive disposal of all host resources and a new listener port.
    const pendingLink = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnectionLink))(
      await value(
        server,
        call(`${executor}.mutations.accountConnect_issue`, { body: { owner: "alice", provider } }),
      ),
    );
    const pendingToken = new URLSearchParams(
      new URL(Redacted.value(pendingLink.url)).hash.slice(1),
    ).get("token");
    assert.ok(pendingToken);
    // An existing app with the original provider declaration upgrades without replacing its account.
    const previous = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
      await value(
        server,
        call(`${executor}.mutations.apps_deploy`, {
          body: {
            owner: "executor-local",
            app: managed.id,
            expectedDeployment: managed.activeDeployment,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, secrets, object, string } from "apps";
const executor = defineProvider({ name: "Executor", auth: { apiKey: secrets({ label: "API key", fields: object({ baseUrl: string(), apiKey: string() }) }) } });
export default defineApp({ accounts: { executor } }, async () => ({  }));`,
              },
            ],
          },
        }),
      ),
    );
    await server.close();
    server = await start(directory);
    const upgraded = await Effect.runPromise((await reader(server)).dashboard.overview());
    const managedAfter = upgraded.apps.find((app) => app.id === managed.id);
    assert.ok(managedAfter);
    assert.ok(managedAfter.activeDeployment !== null);
    assert.equal(
      upgraded.profiles.find((profile) => profile.id === managedProfile.id)?.accounts.executor,
      managedAccount,
    );
    assert.notEqual(managedAfter.activeDeployment, previous.app.activeDeployment);
    const generatedSource = await Effect.runPromise(
      (await reader(server)).dashboard.source({
        params: { app: managed.id, deployment: managedAfter.activeDeployment },
      }),
    );
    assert.ok(generatedSource.files.some((file) => file.path === "operations.json"));
    assert.ok(!JSON.stringify(generatedSource.files).includes(apiKey));
    const resumed = await browserPost("read", {
      connection: pendingLink.connection,
      token: pendingToken,
    });
    assert.equal(resumed.status, 200);
    assert.equal(
      Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(await resumed.json()).state
        .status,
      "pending",
    );
    const cancelled = await browserPost("cancel", {
      connection: pendingLink.connection,
      token: pendingToken,
    });
    assert.equal(cancelled.status, 200);
    await cancelled.body?.cancel();
    const cancelledStatus = Schema.decodeUnknownSync(Schema.toCodecJson(AccountConnection))(
      await value(
        server,
        call(`${executor}.queries.accountConnections_get`, {
          path: { connection: pendingLink.connection },
        }),
      ),
    );
    assert.equal(cancelledStatus.state.status, "cancelled");
    assert.deepEqual(
      Schema.decodeUnknownSync(Schema.Array(Identity))(await value(server, program)),
      expected,
    );
    const executorAfter = Schema.decodeUnknownSync(Search)(
      await value(server, 'return await tools.search({ query: "apps_deploy" })'),
    );
    assert.ok(
      executorAfter.items.some((tool) => tool.path === `${executor}.mutations.apps_deploy`),
    );
    assert.equal(
      Schema.decodeUnknownSync(App)(
        await value(
          server,
          call(`${executor}.queries.appProfiles_get`, {
            path: { app: first.id, profile: firstProfile.id },
          }),
        ),
      ).activeDeployment,
      first.activeDeployment,
    );

    // Every HTTP request must authenticate, even with an existing MCP session.
    for (const method of ["POST", "GET", "DELETE"]) {
      const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "Mcp-Session-Id": server.transport.sessionId ?? "",
        "Mcp-Protocol-Version": "2025-11-25",
      };
      const response = await fetch(server.url, {
        method,
        headers,
        ...(method === "POST"
          ? { body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }) }
          : {}),
      });
      assert.equal(response.status, 401);
      await response.body?.cancel();
    }
    const browser = await fetch(server.url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, origin: "https://example.com" },
    });
    assert.equal(browser.status, 403);
    await browser.body?.cancel();
    const bad = await execute(
      server,
      call(`${appPath(first.slug, firstProfile.id)}.mutations.identify`, { message: 123 }),
    );
    assert.equal(bad.execution.ok, false);
    if (!bad.execution.ok) assert.equal(bad.execution.error.message, "InputInvalid");
    const unknown = await execute(server, "return await tools.nonexistent({})");
    assert.equal(unknown.execution.ok, false);
    if (!unknown.execution.ok) assert.equal(unknown.execution.error.kind, "UnknownTool");
    for (const source of [
      'return fetch("https://example.com")',
      "return process.env",
      'return require("node:fs")',
      "return globalThis",
      'return eval("1")',
      'return Function("return process")()',
      'return tools.constructor.constructor("return process")()',
    ])
      assert.equal((await execute(server, source)).execution.ok, false, source);
    const invalidCode = await execute(server, "const = ;");
    assert.equal(invalidCode.execution.ok, false);
    assert.equal(
      (await server.client.callTool({ name: "execute", arguments: { code: 123 } })).isError,
      true,
    );

    // Current July protocol is stateless. The official client above uses November 2025.
    const modern = await fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "execute",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "execute",
          arguments: { code: "return 42" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    assert.equal(modern.status, 200);
    assert.equal(modern.headers.get("Mcp-Session-Id"), null);
    const modernBody = await modern.text();
    const json = modern.headers.get("content-type")?.includes("text/event-stream")
      ? modernBody
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .at(-1)
          ?.slice(6)
      : modernBody;
    assert.ok(json);
    const response = Schema.decodeUnknownSync(
      Schema.Struct({ result: Schema.Struct({ structuredContent: ExecuteResult }) }),
    )(JSON.parse(json));
    assert.deepEqual(response.result.structuredContent.execution, {
      ok: true,
      value: 42,
      toolCalls: [],
    });

    await verifyCancellation(server, `${appPath(first.slug, firstProfile.id)}.mutations.wait`);
    const renamed = await value(
      server,
      call(`${executor}.mutations.accounts_update`, {
        path: { account: accountA.id },
        body: { label: "Renamed through MCP" },
      }),
    );
    assert.equal(
      Schema.decodeUnknownSync(Schema.Struct({ label: Schema.String }))(renamed).label,
      "Renamed through MCP",
    );
    await value(
      server,
      call(`${executor}.mutations.accounts_replaceCredentials`, {
        path: { account: accountA.id },
        body: { fields: { token: "synthetic-second-key" } },
      }),
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(Identity)(
        await value(
          server,
          call(`${appPath(first.slug, firstProfile.id)}.mutations.identify`, {
            message: "updated",
          }),
        ),
      ),
      { account: accountA.id, identity: "second" },
    );
    await value(
      server,
      call(`${executor}.mutations.appProfiles_update`, {
        path: { app: second.id, profile: secondProfile.id },
        body: {
          expectedRevision: (
            await Effect.runPromise(
              sdk.appProfiles.get({
                params: { app: second.id, profile: secondProfile.id },
                query: {},
              }),
            )
          ).revision,
          accounts: {},
        },
      }),
    );
    assert.equal(
      Schema.decodeUnknownSync(Account)(
        await value(
          server,
          call(`${executor}.queries.accounts_get`, { path: { account: accountB.id } }),
        ),
      ).id,
      accountB.id,
    );
    await value(
      server,
      call(`${executor}.mutations.appProfiles_update`, {
        path: { app: second.id, profile: secondProfile.id },
        body: {
          expectedRevision: (
            await Effect.runPromise(
              sdk.appProfiles.get({
                params: { app: second.id, profile: secondProfile.id },
                query: {},
              }),
            )
          ).revision,
          accounts: { service: accountB.id },
        },
      }),
    );
    await value(
      server,
      call(`${executor}.mutations.accounts_remove`, { path: { account: accountB.id } }),
    );
    const unavailable = await execute(server, "return 1");
    assert.equal(
      unavailable.unavailableApps.find((app) => app.app === second.id)?.reason,
      "AccountNotFound",
    );
    await value(
      server,
      call(`${executor}.mutations.apps_remove`, { path: { app: documented.app.id } }),
    );
    await value(
      server,
      call(`${executor}.mutations.apps_remove`, { path: { app: documented.app.id } }),
    );
    const deletedTools = Schema.decodeUnknownSync(Search)(
      await value(
        server,
        `return await tools.search({ namespace: ${JSON.stringify(documented.app.slug)} })`,
      ),
    );
    assert.equal(deletedTools.items.length, 0);
    await server.close();
    server = await start(directory, { timeoutMs: 1_000, maxToolCalls: 2, maxOutputBytes: 512 });
    assert.equal(
      (await Effect.runPromise((await reader(server)).dashboard.overview())).apps.some(
        (app) => app.id === documented.app.id,
      ),
      false,
    );
    const calls = await execute(
      server,
      `await ${appPath(first.slug, firstProfile.id)}.mutations.identify({message:"1"}); await ${appPath(first.slug, firstProfile.id)}.mutations.identify({message:"2"}); return await ${appPath(first.slug, firstProfile.id)}.mutations.identify({message:"3"})`,
    );
    assert.equal(calls.execution.ok, false);
    if (!calls.execution.ok) assert.equal(calls.execution.error.kind, "ToolCallLimitExceeded");
    assert.equal(calls.execution.toolCalls.length, 2);
    const timeout = await execute(
      server,
      `await ${appPath(first.slug, firstProfile.id)}.mutations.identify({message:"start"}); while (true) {}`,
    );
    assert.equal(timeout.execution.ok, false);
    if (!timeout.execution.ok) assert.equal(timeout.execution.error.kind, "TimeoutExceeded");
    assert.equal(timeout.execution.toolCalls.length, 1);
    const output = await execute(server, 'return "x".repeat(2000)');
    assert.equal(output.execution.truncated, true);
  } finally {
    await server.close();
  }
}

async function verifyCancellation(server: Server, path: string) {
  let entered!: () => void;
  let disconnected!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const probe = createServer((_request, response) => {
    entered();
    response.on("close", disconnected);
  });
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  try {
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const controller = new AbortController();
    const pending = server.client.callTool(
      {
        name: "execute",
        arguments: { code: call(path, { url: `http://127.0.0.1:${address.port}` }) },
      },
      undefined,
      { signal: controller.signal },
    );
    // Attach the rejection observer before sending the cancellation notification.
    const rejected = assert.rejects(pending);
    await started;
    controller.abort();
    await rejected;
    await Promise.race([
      cancelled,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("App HTTP request did not cancel")), 3_000);
        timer.unref();
        void cancelled.then(() => clearTimeout(timer));
      }),
    ]);
  } finally {
    probe.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test(
  "MCP executes real apps and management tools with independent accounts and persistence",
  { timeout: 60_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-mcp-" });
          const fixture = yield* path.fromFileUrl(
            new URL("./fixtures/account-app.ts", import.meta.url),
          );
          const source = yield* fs.readFileString(fixture);
          yield* Effect.tryPromise({
            try: () => verify(directory, source),
            catch: (error) => error,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

test(
  "MCP deferred tool handlers export under the incoming HTTP trace",
  { timeout: 30_000 },
  async () => {
    const batches: string[] = [];
    const collector = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      batches.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    try {
      const address = collector.address();
      assert.ok(address !== null && typeof address !== "string");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped();
            const server = yield* Effect.promise(() =>
              start(directory, defaultMcpLimits, {
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                parent: "00-11111111111111111111111111111111-2222222222222222-01",
              }),
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => server.close()));
            assert.equal(yield* Effect.promise(() => value(server, "return 42")), 42);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      const decoded = Schema.fromJsonString(
        Schema.Struct({
          resourceSpans: Schema.Array(
            Schema.Struct({
              scopeSpans: Schema.Array(
                Schema.Struct({
                  spans: Schema.Array(
                    Schema.Struct({ name: Schema.String, traceId: Schema.String }),
                  ),
                }),
              ),
            }),
          ),
        }),
      );
      const spans = batches.flatMap((body) =>
        Schema.decodeUnknownSync(decoded)(body).resourceSpans.flatMap((r) =>
          r.scopeSpans.flatMap((s) => s.spans),
        ),
      );
      assert.ok(
        spans.some(
          (span) =>
            span.name === "mcp.execute" && span.traceId === "11111111111111111111111111111111",
        ),
        "MCP handler must retain the caller's active telemetry",
      );
    } finally {
      await new Promise<void>((resolve) => collector.close(() => resolve()));
    }
  },
);

test(
  "MCP resume continues the same program, isolates clients, and handles successive and parallel approvals",
  { timeout: 45_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* Effect.promise(async () => {
            const server = await start(directory, { ...defaultMcpLimits, timeoutMs: 1500 });
            const outsider = new Client({ name: "other-client", version: "1" });
            const otherTransport = new StreamableHTTPClientTransport(server.url, {
              requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
            });
            const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = otherTransport;
            try {
              await outsider.connect(compatible);
              const source = `import { withApproval, query, mutation, defineApp, object, string } from "apps";
import { always } from "apps/operations/approval";
const events = [];
export default defineApp({ accounts: {} }, async (appContext) => ({  mutations: { record: mutation({ description: "Record",
            input: object({ value: string() }) }, async (operationContext, { value }) => {
            const _ = { ...appContext, ...operationContext };
            events.push(value);
            return value;
        }),
        guarded: mutation({ description: "Guarded",
            input: object({ value: string() }),
            approval: always() }, async (operationContext, { value }) => {
            const _ = { ...appContext, ...operationContext };
            events.push(value);
            return value;
        }),
        events: mutation({ description: "Events",
            input: object({}) }, async (operationContext, _input) => {
            return [...events];
        }) } }));
`;
              const search = Schema.decodeUnknownSync(Search)(
                await value(server, 'return await tools.search({ query: "apps_deploy" })'),
              );
              const deploy = search.items.find((entry) =>
                entry.path.endsWith(".mutations.apps_deploy"),
              );
              assert.ok(deploy);
              const deployed = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
                await value(
                  server,
                  call(deploy.path, {
                    body: {
                      owner: "approval-tests",
                      name: "Approvals",
                      files: [{ path: "index.ts", content: source }],
                    },
                  }),
                ),
              );
              const tools = appPath(deployed.app.slug);
              const outcome = async (
                name: "execute" | "resume",
                input: Record<string, unknown>,
                client = server.client,
              ) => {
                const result = await client.callTool({ name, arguments: input });
                assert.notEqual(result.isError, true);
                return Schema.decodeUnknownSync(McpExecutionResult)(result.structuredContent);
              };
              const first = await outcome("execute", {
                code: `const before = await ${tools}.mutations.record({value:"before"}); const approved = await ${tools}.mutations.guarded({value:"approved"}); await ${tools}.mutations.record({value:"after"}); return [before, approved];`,
              });
              assert.equal(first.status, "approval-required");
              if (first.status !== "approval-required") throw new Error("Expected pause");
              const prompt = ElicitRequestParamsSchema.parse(first.elicitation);
              assert.equal(prompt.mode, "form");
              assert.match(prompt.message, /Approve mutations\.guarded/);
              assert.match(prompt.message, /"value": "approved"/);
              const accept = ElicitResultSchema.parse({ action: "accept", content: {} });
              const invalidResponse = await server.client.callTool({
                name: "resume",
                arguments: {
                  requestId: first.requestId,
                  response: { action: "accept", content: { value: "changed" } },
                },
              });
              assert.equal(invalidResponse.isError, true);

              assert.deepEqual(await value(server, `return await ${tools}.mutations.events({})`), [
                "before",
              ]);
              assert.equal(
                (
                  await outcome(
                    "resume",
                    { requestId: first.requestId, response: { action: "accept" } },
                    outsider,
                  )
                ).status,
                "unavailable",
              );
              // Human waiting exceeds the execution budget; the original program still continues.
              await new Promise((resolve) => setTimeout(resolve, 1700));
              const finished = await outcome("resume", {
                requestId: first.requestId,
                response: accept,
              });
              assert.equal(finished.status, "completed");
              if (finished.status !== "completed") throw new Error("Expected result");
              assert.deepEqual(finished.execution.ok && finished.execution.value, [
                "before",
                "approved",
              ]);
              assert.deepEqual(await value(server, `return await ${tools}.mutations.events({})`), [
                "before",
                "approved",
                "after",
              ]);
              assert.equal(
                (
                  await outcome("resume", {
                    requestId: first.requestId,
                    response: { action: "accept" },
                  })
                ).status,
                "unavailable",
              );

              const sequential = await outcome("execute", {
                code: `const a = await ${tools}.mutations.guarded({value:"one"}); const b = await ${tools}.mutations.guarded({value:"two"}); return [a,b];`,
              });
              assert.equal(sequential.status, "approval-required");
              if (sequential.status !== "approval-required")
                throw new Error("Expected first pause");
              const next = await outcome("resume", {
                requestId: sequential.requestId,
                response: { action: "accept" },
              });
              assert.equal(next.status, "approval-required");
              if (next.status !== "approval-required") throw new Error("Expected next pause");
              const denied = await outcome("resume", {
                requestId: next.requestId,
                response: { action: "decline" },
              });
              assert.equal(denied.status, "completed");
              if (denied.status === "completed") assert.equal(denied.execution.ok, false);
              assert.deepEqual(await value(server, `return await ${tools}.mutations.events({})`), [
                "before",
                "approved",
                "after",
                "one",
              ]);

              const cancelPause = await outcome("execute", {
                code: `return await ${tools}.mutations.guarded({value:"cancelled"});`,
              });
              if (cancelPause.status !== "approval-required") throw new Error("Expected pause");
              const cancelled = await outcome("resume", {
                requestId: cancelPause.requestId,
                response: { action: "cancel" },
              });
              assert.equal(cancelled.status, "completed");
              if (cancelled.status === "completed") {
                assert.equal(cancelled.execution.ok, false);
                if (!cancelled.execution.ok)
                  assert.equal(cancelled.execution.error.message, "ApprovalCancelled");
              }
              assert.deepEqual(await value(server, `return await ${tools}.mutations.events({})`), [
                "before",
                "approved",
                "after",
                "one",
              ]);

              let parallel = await outcome("execute", {
                code: `return await Promise.all([${tools}.mutations.guarded({value:"parallel-one"}), ${tools}.mutations.guarded({value:"parallel-two"})]);`,
              });
              let approvals = 0;
              while (parallel.status === "approval-required") {
                approvals++;
                assert.ok(approvals <= 2);
                parallel = await outcome("resume", {
                  requestId: parallel.requestId,
                  response: { action: "accept" },
                });
              }
              assert.equal(approvals, 2, JSON.stringify(parallel));
              assert.equal(parallel.status, "completed");
              if (parallel.status === "completed")
                assert.deepEqual(parallel.execution.ok && parallel.execution.value, [
                  "parallel-one",
                  "parallel-two",
                ]);
            } finally {
              await outsider.close();
              await server.close();
            }
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
  },
);

test(
  "native and model MCP share policy and running-tool input without replay or human wait charges",
  { timeout: 30_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* Effect.promise(async () => {
            const server = await start(directory, { ...defaultMcpLimits, timeoutMs: 2000 });
            const native = new Client(
              { name: "live-tool-input", version: "1" },
              { capabilities: { elicitation: { form: {} } } },
            );
            try {
              const source = `import { withApproval, query, mutation, defineApp, object } from "apps";
import { always } from "apps/operations/approval";
let starts = 0, finishes = 0;
const ask = mutation({ description: "Ask for input", input: object({}) }, async ({ elicit }) => {
    const marker = ++starts;
    const reply = await elicit({ mode: "form", message: "Name this result", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
    if (reply.action !== "accept")
        return { marker, action: reply.action };
    finishes++;
    return { marker, name: reply.content.name };
});
const parallel = mutation({ description: "Ask twice", input: object({}) }, async ({ elicit }) => {
    const marker = ++starts;
    const replies = await Promise.all(["first", "second"].map(message => elicit({ mode: "form", message, requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } })));
    finishes++;
    return { marker, replies: replies.map(reply => reply.action === "accept" ? reply.content.name : reply.action) };
});
export default defineApp({ accounts: {} }, async () => ({  mutations: { ask, parallel, guarded: withApproval(ask, always()), counts: mutation({ description: "Counts", input: object({}) }, async () => ({ starts, finishes })) } }));
`;
              const deployed = await fetch(new URL("/v1/apps/deploy", server.url), {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({
                  owner: "live-input-test",
                  name: "Live input",
                  files: [{ path: "index.ts", content: source }],
                }),
              });
              assert.equal(deployed.status, 200);
              const { app } = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
                await deployed.json(),
              );
              const endpoint = new URL(server.url);
              endpoint.searchParams.set("elicitation_mode", "native");
              const transport = new StreamableHTTPClientTransport(endpoint, {
                requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
              });
              const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
              await native.connect(compatible);
              let policies = 0,
                questions = 0;
              native.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
                if (params.message.startsWith("Approve mutations.guarded?")) {
                  policies++;
                  return { action: "accept", content: {} };
                }
                assert.equal(params.message, "Name this result");
                questions++;
                await new Promise((resolve) => setTimeout(resolve, 2500));
                return { action: "accept", content: { name: "Ada" } };
              });
              const result = Schema.decodeUnknownSync(McpExecutionResult)(
                (
                  await native.callTool({
                    name: "execute",
                    arguments: {
                      code: `const result=await tools[${JSON.stringify(app.slug)}].mutations.guarded({}); return {result,counts:await tools[${JSON.stringify(app.slug)}].mutations.counts({})};`,
                    },
                  })
                ).structuredContent,
              );
              assert.ok(
                result.status === "completed" && result.execution.ok,
                JSON.stringify(result),
              );
              assert.deepEqual(result.execution.value, {
                result: { marker: 1, name: "Ada" },
                counts: { starts: 1, finishes: 1 },
              });
              assert.equal(policies, 1);
              assert.equal(questions, 1, "policy acceptance does not answer the tool's own form");
              native.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
                await new Promise((resolve) =>
                  setTimeout(resolve, params.message === "first" ? 2500 : 1200),
                );
                return { action: "accept", content: { name: params.message } };
              });
              const parallel = Schema.decodeUnknownSync(McpExecutionResult)(
                (
                  await native.callTool({
                    name: "execute",
                    arguments: {
                      code: `return await tools[${JSON.stringify(app.slug)}].mutations.parallel({});`,
                    },
                  })
                ).structuredContent,
              );
              assert.ok(
                parallel.status === "completed" && parallel.execution.ok,
                JSON.stringify(parallel),
              );
              assert.deepEqual(parallel.execution.value, {
                marker: 2,
                replies: ["first", "second"],
              });

              for (const action of ["decline", "cancel"] as const) {
                native.setRequestHandler(ElicitRequestSchema, async () => ({ action }));
                const result = Schema.decodeUnknownSync(McpExecutionResult)(
                  (
                    await native.callTool({
                      name: "execute",
                      arguments: {
                        code: `return await tools[${JSON.stringify(app.slug)}].mutations.ask({});`,
                      },
                    })
                  ).structuredContent,
                );
                assert.ok(result.status === "completed" && result.execution.ok);
                assert.ok(JSON.stringify(result.execution.value).includes(action));
              }
              const request = async (name: string, args: Record<string, unknown>) => {
                const wire = await server.client.callTool({ name, arguments: args });
                assert.notEqual(wire.isError, true, JSON.stringify(wire));
                return Schema.decodeUnknownSync(McpExecutionResult)(wire.structuredContent);
              };
              const guarded = await request("execute", {
                code: `const before="retained"; const result=await tools[${JSON.stringify(app.slug)}].mutations.guarded({}); return {before,result,counts:await tools[${JSON.stringify(app.slug)}].mutations.counts({})};`,
              });
              assert.equal(guarded.status, "approval-required");
              if (guarded.status !== "approval-required")
                throw new Error("Expected policy approval");
              const question = await request("resume", {
                requestId: guarded.requestId,
                response: { action: "accept" },
              });
              assert.equal(question.status, "input-required");
              if (question.status !== "input-required") throw new Error("Expected tool input");
              assert.equal(question.elicitation.message, "Name this result");
              const invalid = await server.client.callTool({
                name: "resume",
                arguments: {
                  requestId: question.requestId,
                  response: { action: "accept", content: { name: 42 } },
                },
              });
              assert.equal(invalid.isError, true);
              await new Promise((resolve) => setTimeout(resolve, 2500));
              const answered = await request("resume", {
                requestId: question.requestId,
                response: { action: "accept", content: { name: "Grace" } },
              });
              assert.ok(
                answered.status === "completed" && answered.execution.ok,
                JSON.stringify(answered),
              );
              assert.deepEqual(answered.execution.value, {
                before: "retained",
                result: { marker: 5, name: "Grace" },
                counts: { starts: 5, finishes: 3 },
              });
              assert.equal(
                (
                  await request("resume", {
                    requestId: question.requestId,
                    response: { action: "accept", content: { name: "duplicate" } },
                  })
                ).status,
                "unavailable",
              );
              let interaction = await request("execute", {
                code: `return await tools[${JSON.stringify(app.slug)}].mutations.parallel({});`,
              });
              const answers: string[] = [];
              while (interaction.status === "input-required") {
                const name = interaction.elicitation.message;
                answers.push(name);
                interaction = await request("resume", {
                  requestId: interaction.requestId,
                  response: { action: "accept", content: { name } },
                });
              }
              assert.deepEqual(answers, ["first", "second"]);
              assert.ok(
                interaction.status === "completed" && interaction.execution.ok,
                JSON.stringify(interaction),
              );
              assert.deepEqual(interaction.execution.value, {
                marker: 6,
                replies: ["first", "second"],
              });
              for (const action of ["decline", "cancel"] as const) {
                const question = await request("execute", {
                  code: `return await tools[${JSON.stringify(app.slug)}].mutations.ask({});`,
                });
                if (question.status !== "input-required") throw new Error("Expected input");
                const done = await request("resume", {
                  requestId: question.requestId,
                  response: { action },
                });
                assert.ok(done.status === "completed" && done.execution.ok, JSON.stringify(done));
                assert.ok(JSON.stringify(done.execution.value).includes(action));
              }
            } finally {
              await native.close();
              await server.close();
            }
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    );
  },
);

for (const upstream of ["http", "stdio"] as const)
  test(
    `upstream ${upstream} forms use native and model delivery without replay`,
    { timeout: 60_000 },
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped();
            const fixture = yield* path.fromFileUrl(
              new URL("./fixtures/eliciting-stdio.ts", import.meta.url),
            );
            const journal = path.join(directory, "stdio.jsonl");
            let cancelQuestion: (() => void) | undefined;
            yield* Effect.promise(() =>
              withElicitingMcp(
                {
                  onQuestion: (cancel) => {
                    cancelQuestion = cancel;
                  },
                },
                async ({ url, events, sessions }) => {
                  const server = await start(directory);
                  const native = new Client(
                    { name: "upstream-native-check", version: "1" },
                    { capabilities: { elicitation: { form: {} } } },
                  );
                  try {
                    const helper =
                      upstream === "http"
                        ? `mcpOperations({url:${JSON.stringify(url)},timeoutMs:1500,signal:ctx.signal})`
                        : `stdioOperations({command:${JSON.stringify(process.execPath)},args:${JSON.stringify([fixture, journal])},env:{},timeoutMs:1500},ctx.signal)`;
                    const source = `import { defineApp, withApproval } from "apps";
import { ${upstream === "http" ? "mcpOperations" : "stdioOperations"} } from "${upstream === "http" ? "apps/mcp" : "apps/mcp/stdio"}";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async (ctx) => { const operations = await ${helper}; return {  ...operations, mutations: { ...operations.mutations, ask: withApproval(operations.mutations.ask, always()) } }; });
`;
                    const deployed = await fetch(new URL("/v1/apps/deploy", server.url), {
                      method: "POST",
                      headers: {
                        authorization: `Bearer ${apiKey}`,
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({
                        owner: "upstream-input-test",
                        name: "Upstream input",
                        files: [
                          { path: "index.ts", content: source },
                          {
                            path: "package.json",
                            content: JSON.stringify({
                              dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
                            }),
                          },
                        ],
                      }),
                    });
                    assert.equal(deployed.status, 200, await deployed.clone().text());
                    const { app } = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
                      await deployed.json(),
                    );
                    const endpoint = new URL(server.url);
                    endpoint.searchParams.set("elicitation_mode", "native");
                    const transport = new StreamableHTTPClientTransport(endpoint, {
                      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
                    });
                    const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
                    await native.connect(compatible);
                    for (const mode of ["native", "model"] as const) {
                      let prompts = 0,
                        policies = 0;
                      const markers = new Set<unknown>();
                      const answer = async (params: {
                        message: string;
                        _meta?: Record<string, unknown> | undefined;
                      }) => {
                        if (params.message.startsWith("Approve mutations.ask?")) {
                          policies++;
                          return { action: "accept" as const, content: {} };
                        }
                        prompts++;
                        markers.add(params._meta?.marker);
                        assert.equal(params._meta?.origin, "https://fixture.example");
                        assert.deepEqual(params._meta?.persist, ["session", "always"]);
                        if (prompts === 1)
                          await new Promise((resolve) => setTimeout(resolve, 1750));
                        return {
                          action: "accept" as const,
                          content: { answer: params.message },
                          _meta: { persist: "session" },
                        };
                      };
                      native.setRequestHandler(ElicitRequestSchema, ({ params }) => answer(params));
                      const client = mode === "native" ? native : server.client;
                      let result = Schema.decodeUnknownSync(McpExecutionResult)(
                        (
                          await client.callTool({
                            name: "execute",
                            arguments: {
                              code: `const before="preserved";const result=await tools[${JSON.stringify(app.slug)}].mutations.ask({value:${JSON.stringify(mode)}});return {before,result};`,
                            },
                          })
                        ).structuredContent,
                      );
                      while (
                        result.status === "input-required" ||
                        result.status === "approval-required"
                      ) {
                        assert.equal(mode, "model");
                        result = Schema.decodeUnknownSync(McpExecutionResult)(
                          (
                            await client.callTool({
                              name: "resume",
                              arguments: {
                                requestId: result.requestId,
                                response: await answer(result.elicitation),
                              },
                            })
                          ).structuredContent,
                        );
                      }
                      assert.ok(
                        result.status === "completed" && result.execution.ok,
                        JSON.stringify(result),
                      );
                      const output = Schema.decodeUnknownSync(
                        Schema.Struct({
                          before: Schema.String,
                          result: Schema.Struct({
                            structuredContent: Schema.Struct({
                              marker: Schema.String,
                              responses: Schema.Array(Schema.Json),
                            }),
                          }),
                        }),
                      )(result.execution.value);
                      assert.equal(output.before, "preserved");
                      assert.equal(prompts, 2);
                      assert.equal(policies, 1);
                      assert.deepEqual([...markers], [output.result.structuredContent.marker]);
                      assert.deepEqual(
                        output.result.structuredContent.responses,
                        [1, 2].map((n) => ({
                          action: "accept",
                          content: { answer: `${mode}:${n}` },
                          _meta: { persist: "session" },
                        })),
                      );
                    }
                    if (upstream === "http") {
                      assert.deepEqual(
                        events.filter((event) => event.startsWith("call:")),
                        ["call:native", "call:model"],
                      );
                      const pause = Schema.decodeUnknownSync(McpExecutionResult)(
                        (
                          await server.client.callTool({
                            name: "execute",
                            arguments: {
                              code: `return await tools[${JSON.stringify(app.slug)}].mutations.ask({value:"cancelled"});`,
                            },
                          })
                        ).structuredContent,
                      );
                      if (pause.status !== "approval-required")
                        throw new Error("Expected policy approval");
                      const question = Schema.decodeUnknownSync(McpExecutionResult)(
                        (
                          await server.client.callTool({
                            name: "resume",
                            arguments: {
                              requestId: pause.requestId,
                              response: { action: "accept" },
                            },
                          })
                        ).structuredContent,
                      );
                      if (question.status !== "input-required")
                        throw new Error("Expected upstream question");
                      assert.ok(cancelQuestion);
                      cancelQuestion();
                      const deadline = Date.now() + 3000;
                      while (sessions.size > 0 && Date.now() < deadline)
                        await new Promise((resolve) => setTimeout(resolve, 10));
                      assert.equal(sessions.size, 0);
                      const lost = Schema.decodeUnknownSync(McpExecutionResult)(
                        (
                          await server.client.callTool({
                            name: "resume",
                            arguments: {
                              requestId: question.requestId,
                              response: { action: "accept", content: { answer: "late" } },
                            },
                          })
                        ).structuredContent,
                      );
                      assert.equal(lost.status, "unavailable");
                      assert.equal(events.filter((event) => event === "call:cancelled").length, 1);
                      assert.equal(events.includes("done:cancelled"), false);
                    } else {
                      const records = (await Effect.runPromise(fs.readFileString(journal)))
                        .trim()
                        .split("\n")
                        .map((line) =>
                          Schema.decodeUnknownSync(
                            Schema.fromJsonString(
                              Schema.Struct({ pid: Schema.Number, event: Schema.String }),
                            ),
                          )(line),
                        );
                      assert.deepEqual(
                        records
                          .filter(({ event }) => event.startsWith("call:"))
                          .map(({ event }) => event),
                        ["call:native", "call:model"],
                      );
                      for (const pid of new Set(records.map(({ pid }) => pid)))
                        assert.throws(() => process.kill(pid, 0));
                    }
                  } finally {
                    await native.close();
                    await server.close();
                  }
                },
              ),
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
  );

test(
  "MCP discovers and calls authored queries and mutations without tool wrappers",
  { timeout: 30_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* Effect.promise(async () => {
            const server = await start(directory);
            try {
              const source = `import { defineApp, defineDatabase, table, object, string, array , query, mutation} from "apps";
const database = defineDatabase({ messages: table({ body: string() }) });
const Message = object({ id: string(), body: string() });
export default defineApp({ accounts: {}, database }, async () => ({  queries: {
        list: query({ description: "Read persisted agent messages", input: object({}), output: array(Message) }, async ({ db }) => db.messages.withIndex("by_creation").collect()),
        forbidden: query({ input: object({}), output: Message }, async ({ db }) => db.messages.insert({ body: "forbidden" }))
    }, mutations: {
        add: mutation({ description: "Save an agent message", input: object({ body: string() }), output: Message }, async ({ db }, message) => db.messages.insert(message)),
        broken: mutation({ input: object({ body: string() }), output: Message }, async ({ db }, message) => { await db.messages.insert(message); throw new Error("rollback"); })
    } }));
`;
              const deployed = await fetch(new URL("/v1/apps/deploy", server.url), {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({
                  owner: "mcp-test",
                  name: "Agent database",
                  files: [{ path: "index.ts", content: source }],
                }),
              });
              assert.equal(
                deployed.status,
                200,
                deployed.status === 200 ? "" : await deployed.text(),
              );
              const app = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
                await deployed.json(),
              ).app;
              const found = Schema.decodeUnknownSync(Search)(
                await value(server, 'return await tools.search({ query: "Agent database" })'),
              );
              const list = found.items.find((item) => item.path.includes("queries.list"));
              const add = found.items.find((item) => item.path.includes("mutations.add"));
              const broken = found.items.find((item) => item.path.includes("mutations.broken"));
              const forbidden = found.items.find((item) => item.path.includes("queries.forbidden"));
              assert.ok(list);
              assert.ok(add);
              assert.ok(broken);
              assert.ok(forbidden);
              assert.ok(list.path.includes(app.slug));
              assert.deepEqual(await value(server, call(list.path, {})), []);
              const saved = await value(server, call(add.path, { body: "From MCP" }));
              assert.deepEqual(await value(server, call(list.path, {})), [saved]);
              assert.equal(
                (await execute(server, call(broken.path, { body: "not committed" }))).execution.ok,
                false,
              );
              assert.equal((await execute(server, call(forbidden.path, {}))).execution.ok, false);
              assert.deepEqual(await value(server, call(list.path, {})), [saved]);
            } finally {
              await server.close();
            }
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

test(
  "browser MCP collects cookie-authenticated decisions for policy and running-tool input",
  { timeout: 30_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          yield* Effect.promise(async () => {
            const server = await start(directory);
            const client = new Client({ name: "browser-approval-check", version: "1" });
            try {
              const pair = await fetch(new URL("/auth/pair", server.url), {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}` },
              });
              assert.equal(pair.status, 200);
              const link = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
                await pair.json(),
              );
              const exchange = await fetch(new URL("/auth/exchange", server.url), {
                method: "POST",
                headers: { origin: server.url.origin, "content-type": "application/json" },
                body: JSON.stringify({
                  token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("pair"),
                }),
              });
              assert.equal(exchange.status, 200);
              const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
              assert.ok(cookie);
              const source = `import {defineApp,object,query,mutation} from "apps";import {always} from "apps/operations/approval";
let starts=0;
export default defineApp({accounts:{}},async()=>({mutations:{ask:mutation({description:"Ask",input:object({}),approval:always()},async({elicit})=>{const marker=++starts;const response=await elicit({mode:"form",message:"Choose a name",requestedSchema:{type:"object",properties:{name:{type:"string",minLength:1}},required:["name"]}});return {marker,response};})},queries:{count:query({description:"Count",input:object({})},async()=>starts)}}));`;
              const deployed = await fetch(new URL("/v1/apps/deploy", server.url), {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({
                  owner: "browser-test",
                  name: "Browser fixture",
                  files: [{ path: "index.ts", content: source }],
                }),
              });
              assert.equal(deployed.status, 200);
              const { app } = Schema.decodeUnknownSync(Schema.Struct({ app: App }))(
                await deployed.json(),
              );
              const endpoint = new URL(server.url);
              endpoint.searchParams.set("elicitation_mode", "browser");
              const transport = new StreamableHTTPClientTransport(endpoint, {
                requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
              });
              const compatible: Omit<StreamableHTTPClientTransport, "sessionId"> = transport;
              await client.connect(compatible);
              const tools = (await client.listTools()).tools;
              assert.deepEqual(
                Object.keys(
                  tools.find((tool) => tool.name === "resume")?.inputSchema.properties ?? {},
                ),
                ["requestId"],
              );
              const decode = Schema.decodeUnknownSync(BrowserExecutionResult);
              const pending = decode(
                (
                  await client.callTool({
                    name: "execute",
                    arguments: { code: `return await ${appPath(app.slug)}.mutations.ask({});` },
                  })
                ).structuredContent,
              );
              if (pending.status !== "approval-required")
                throw new Error("Expected browser approval");
              const linkUrl = new URL(pending.approvalUrl);
              assert.equal(linkUrl.origin, server.url.origin);
              const api = new URL(
                `/dashboard/api/mcp/approvals/${pending.requestId}${linkUrl.search}`,
                server.url,
              );
              assert.equal((await fetch(api)).status, 401);
              assert.equal(
                (await fetch(api, { headers: { authorization: `Bearer ${apiKey}` } })).status,
                403,
              );
              assert.equal(
                (await fetch(api, { headers: { cookie, origin: "https://wrong.example" } })).status,
                403,
              );
              const get = await fetch(api, { headers: { cookie } });
              assert.equal(get.status, 200);
              assert.equal(get.headers.get("cache-control"), "no-store");
              assert.equal(
                Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(await get.json())
                  .status,
                "pending",
              );
              const submit = (url: URL, response: object, origin = server.url.origin) =>
                fetch(url, {
                  method: "POST",
                  headers: { cookie, origin, "content-type": "application/json" },
                  body: JSON.stringify({ response }),
                });
              assert.equal(
                (await submit(api, { action: "accept" }, "https://wrong.example")).status,
                403,
              );
              assert.equal(
                (await submit(api, { action: "accept", content: { replacement: true } })).status,
                400,
              );
              const aborted = new AbortController();
              const waiting = client.callTool(
                { name: "resume", arguments: { requestId: pending.requestId } },
                undefined,
                { signal: aborted.signal },
              );
              const interrupted = assert.rejects(waiting);
              setTimeout(() => aborted.abort(), 100);
              await interrupted;
              assert.equal(
                Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(
                  await (await fetch(api, { headers: { cookie } })).json(),
                ).status,
                "pending",
              );
              assert.equal((await submit(api, { action: "accept" })).status, 200);
              assert.equal((await submit(api, { action: "decline" })).status, 200);
              const before = await value(
                server,
                `return await ${appPath(app.slug)}.queries.count({});`,
              );
              assert.equal(before, 0);
              const question = decode(
                (
                  await client.callTool({
                    name: "resume",
                    arguments: { requestId: pending.requestId },
                  })
                ).structuredContent,
              );
              if (question.status !== "input-required") throw new Error("Expected browser form");
              const questionUrl = new URL(question.approvalUrl);
              const questionApi = new URL(
                `/dashboard/api/mcp/approvals/${question.requestId}${questionUrl.search}`,
                server.url,
              );
              assert.equal(
                (await submit(questionApi, { action: "accept", content: { name: 42 } })).status,
                400,
              );
              assert.equal(
                (await submit(questionApi, { action: "accept", content: { name: "Browser" } }))
                  .status,
                200,
              );
              const result = decode(
                (
                  await client.callTool({
                    name: "resume",
                    arguments: { requestId: question.requestId },
                  })
                ).structuredContent,
              );
              assert.ok(
                result.status === "completed" && result.execution.ok,
                JSON.stringify(result),
              );
              assert.deepEqual(result.execution.value, {
                marker: 1,
                response: { action: "accept", content: { name: "Browser" } },
              });
              assert.equal(
                decode(
                  (
                    await client.callTool({
                      name: "resume",
                      arguments: { requestId: question.requestId },
                    })
                  ).structuredContent,
                ).status,
                "unavailable",
              );
            } finally {
              await client.close();
              await server.close();
            }
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
