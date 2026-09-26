/** Failed and timed-out MCP executions report what happened instead of losing it. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { requestGate } from "../support/request-gate.ts";

/** Execution budget used by every product; the app's slow tool outlasts it. */
const executionTimeoutMs = 30_000;

// A refresh that runs until its 30 s background limit unless cancelled.
const slowRefresh = `const slowRefresh = (signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, 60_000);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
});
const swr = { key: "swr", schema: string(), freshFor: 0, staleFor: "10 minutes" };`;

// `first` returns at once and `slow` outlasts the execution budget. `seed` caches a value that
// is stale at once; `stale` serves it and keeps refreshing it after the call returns. The
// approved mutation records that it ran, so a scenario can prove it never did.
const slowAppSource = `import { defineApp, query, mutation, object, boolean, string } from "apps";
import { always } from "apps/operations/approval";
${slowRefresh}
export default defineApp({ accounts: {} }, async (ctx) => ({
  queries: {
    first: query({ input: object({}) }, async () => ({ n: 1 })),
    pause: query({ input: object({}) }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return true;
    }),
    seed: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async () => "seed" })),
    stale: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async ({ signal }) => {
      await slowRefresh(signal);
      return "refreshed";
    } })),
    slow: query({ input: object({}) }, async () => {
      await new Promise((resolve) => setTimeout(resolve, ${executionTimeoutMs + 20_000}));
      return { n: 2 };
    }),
    approvedRan: query({ input: object({}) }, async () => (await ctx.cache.read("approved-ran", boolean())) ?? false),
  },
  mutations: {
    approved: mutation({ input: object({}), approval: always() }, async () => {
      await ctx.cache.write([{ key: "approved-ran", value: true }], "1 hour");
      return { ran: true };
    }),
  },
}));`;

// The second read serves the cached value and starts a refresh that outlasts the result.
const refreshAppSource = `import { defineApp, query, object, string } from "apps";
${slowRefresh}
export default defineApp({ accounts: {} }, async (ctx) => ({ queries: {
  seed: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async () => "seed" })),
  stale: query({ input: object({}) }, async () => ctx.cache.get({ ...swr, load: async ({ signal }) => {
    await slowRefresh(signal);
    return "refreshed";
  } })),
} }));`;

// A required account that nobody has selected keeps the app out of the catalog.
const accountAppSource = `import { defineApp, defineProvider, secrets, object, string, query } from "apps";
const service = defineProvider({ name: "Unselected fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async () => ({ queries: {
  read: query({ input: object({}), description: "Read an item" }, async () => "item"),
} }));`;

const Failed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
      response: Schema.optional(Schema.Struct({ code: Schema.String, status: Schema.Number })),
    }),
  }),
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
    logs: Schema.optional(Schema.Array(Schema.String)),
  }),
});

const TimedOut = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ kind: Schema.String, message: Schema.String }),
    logs: Schema.optional(Schema.Array(Schema.String)),
    toolCalls: Schema.Array(
      Schema.Struct({ name: Schema.String, outcome: Schema.optional(Schema.String) }),
    ),
  }),
});

const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});

type Connected = Effect.Success<ReturnType<Effect.Success<typeof McpClient>["connect"]>>;

/**
 * Run a program that completes calls, logs, then stalls, and check what the timeout reports.
 * A call made after a pause leaves a cache refresh running for 30 s, so closing the run is still
 * slow more than a second after the budget ends.
 */
const checkTimeoutReport = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const app = `tools[${JSON.stringify(slug)}]`;
    const code = `const first = await ${app}.queries.first({});
await ${app}.queries.pause({});
await ${app}.queries.seed({});
await ${app}.queries.stale({});
console.log("first call finished", first.n);
await ${app}.queries.slow({});
return "unreachable";`;
    const started = yield* Clock.currentTimeMillis;
    const result = yield* client.use(
      "Execute a program that outlasts its budget",
      (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, {
          signal,
          timeout: 55_000,
        }),
    );
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    yield* evidence.json("timeout-result.json", { elapsed, result: result.structuredContent });
    const timedOut = yield* Schema.decodeUnknownEffect(TimedOut)(result.structuredContent);
    // A timeout is reported as a timeout, never as a lost continuation.
    expect(timedOut.execution.error.kind).toBe("TimeoutExceeded");
    expect(timedOut.execution.error.message).toContain("earlier tool calls may have completed");
    // Output written before the timeout is returned.
    expect(timedOut.execution.logs ?? []).toContainEqual(
      expect.stringContaining("first call finished 1"),
    );
    // Each admitted call reports whether it finished.
    expect(timedOut.execution.toolCalls).toEqual([
      expect.objectContaining({ name: `${slug}.queries.first`, outcome: "success" }),
      expect.objectContaining({ name: `${slug}.queries.pause`, outcome: "success" }),
      expect.objectContaining({ name: `${slug}.queries.seed`, outcome: "success" }),
      expect.objectContaining({ name: `${slug}.queries.stale`, outcome: "success" }),
      expect.objectContaining({ name: `${slug}.queries.slow`, outcome: "interrupted" }),
    ]);
    // The result arrives at the budget, not after the slow tool. Workers advance their clock
    // only at I/O, so a Cloud timer can end slightly before the client's wall time says it should.
    expect(elapsed).toBeGreaterThanOrEqual(executionTimeoutMs - 1_000);
    expect(elapsed).toBeLessThan(executionTimeoutMs + 10_000);
  });

/** Run one execute and return its decoded completed result with the client's elapsed time. */
const executeOnce = (client: Connected, label: string, code: string, file: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const started = yield* Clock.currentTimeMillis;
    const result = yield* client.use(label, (client, signal) =>
      client.callTool({ name: "execute", arguments: { code } }, undefined, {
        signal,
        timeout: 55_000,
      }),
    );
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    yield* evidence.json(file, { elapsed, result: result.structuredContent });
    return { elapsed, structured: result.structuredContent };
  });

/** A program that finishes returns at once, even when a tool left a background refresh running. */
const checkRefreshNotAwaited = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const app = `tools[${JSON.stringify(slug)}]`;
    const seeded = yield* executeOnce(
      client,
      "Cache a value that is immediately stale",
      `return await ${app}.queries.seed({});`,
      "refresh-seed.json",
    );
    expect(yield* Schema.decodeUnknownEffect(Completed)(seeded.structured)).toMatchObject({
      execution: { ok: true, value: "seed" },
    });
    const served = yield* executeOnce(
      client,
      "Read the stale value while its refresh keeps running",
      `const value = await ${app}.queries.stale({});
console.log("served", value);
return value;`,
      "refresh-served.json",
    );
    const completed = yield* Schema.decodeUnknownEffect(Completed)(served.structured);
    // The program's own result is returned, not a timeout caused by the refresh.
    expect(completed.execution.error).toBeUndefined();
    expect(completed.execution).toMatchObject({ ok: true, value: "seed" });
    expect(completed.execution.logs ?? []).toContainEqual(expect.stringContaining("served seed"));
    // The refresh runs for up to 30 s after the result; the result does not wait for it.
    expect(served.elapsed).toBeLessThan(10_000);
  });

/** A call that needs approval must not pause, or later run, an execution past its budget. */
const checkNoApprovalAfterDeadline = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const app = `tools[${JSON.stringify(slug)}]`;
    const raced = yield* executeOnce(
      client,
      "Request an approval beside a call that outlasts the budget",
      `return await Promise.all([${app}.mutations.approved({}), ${app}.queries.slow({})]);`,
      "approval-deadline.json",
    );
    const status = yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(
      raced.structured,
    );
    // The budget ends the execution as a timeout; it never parks on the approval.
    expect(status.status).toBe("completed");
    const timedOut = yield* Schema.decodeUnknownEffect(TimedOut)(raced.structured);
    expect(timedOut.execution.error.kind).toBe("TimeoutExceeded");
    // The mutation was still waiting for approval, so it is not reported as possibly applied.
    expect(timedOut.execution.toolCalls).toEqual([
      expect.objectContaining({ name: `${slug}.mutations.approved`, outcome: "awaiting-approval" }),
      expect.objectContaining({ name: `${slug}.queries.slow`, outcome: "interrupted" }),
    ]);
    const ran = yield* executeOnce(
      client,
      "Check whether the approved mutation ran",
      `return await ${app}.queries.approvedRan({});`,
      "approval-ran.json",
    );
    expect(yield* Schema.decodeUnknownEffect(Completed)(ran.structured)).toMatchObject({
      execution: { ok: true, value: false },
    });
  });

/**
 * An approval is requested as soon as the call asks for it, even while an earlier call's cache
 * refresh keeps running in the background. Approving it runs the mutation.
 */
const checkApprovalAfterRefresh = (client: Connected, slug: string) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const app = `tools[${JSON.stringify(slug)}]`;
    const parked = yield* executeOnce(
      client,
      "Ask for approval after a read that leaves a cache refresh running",
      `await ${app}.queries.seed({});
const value = await ${app}.queries.stale({});
console.log("served", value);
return await ${app}.mutations.approved({});`,
      "approval-after-refresh.json",
    );
    const pending = yield* Schema.decodeUnknownEffect(Pending)(parked.structured);
    // The refresh runs for up to 30 s; the approval request does not wait for it.
    expect(parked.elapsed).toBeLessThan(10_000);
    const started = yield* Clock.currentTimeMillis;
    const resumed = yield* client.use("Approve the mutation", (client, signal) =>
      client.callTool(
        {
          name: "resume",
          arguments: { requestId: pending.requestId, response: { action: "accept" } },
        },
        undefined,
        { signal, timeout: 55_000 },
      ),
    );
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    yield* evidence.json("approval-after-refresh-resumed.json", {
      elapsed,
      result: resumed.structuredContent,
    });
    const completed = yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent);
    expect(completed.execution).toMatchObject({ ok: true, value: { ran: true } });
    expect(completed.execution.logs ?? []).toContainEqual(expect.stringContaining("served seed"));
    expect(elapsed).toBeLessThan(10_000);
  });

/** Deploy an app in the hosted organization and connect a PAT MCP client to it. */
const hostedApp = (name: string, source: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      mcp = yield* McpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", { name }),
    );
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: source }],
    });
    expect(deployed.status).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
      }).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key, name.toLowerCase().replaceAll(" ", "-"), {
      organization: actors.organization.id,
    });
    return { client, slug: app.slug };
  });

/** Deploy an app on local and connect an MCP client with the local API key. */
const localApp = (name: string, source: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      target = yield* Target,
      mcp = yield* McpClient,
      session = yield* api.session();
    const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
    const deployed = yield* session.send(
      "POST",
      "/v1/apps/deploy",
      {
        owner: "local",
        name: `${name} ${randomUUID().slice(0, 8)}`,
        files: [{ path: "index.ts", content: source }],
      },
      headers,
    );
    expect(deployed.status).toBe(200);
    const { app } = yield* body(
      Schema.Struct({ app: Schema.Struct({ id: Schema.String, slug: Schema.String }) }),
      deployed,
    );
    yield* Effect.addFinalizer(() =>
      session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(target.apiKey, name.toLowerCase().replaceAll(" ", "-"));
    return { client, slug: app.slug };
  });

layer(HostedLive, { excludeTestServices: true })("Hosted MCP execute failures", (it) => {
  it.effect(scenarios.mcpExecuteTimeoutReport.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Slow tools", slowAppSource);
        yield* checkTimeoutReport(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteTimeoutApproval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Deadline approval", slowAppSource);
        yield* checkNoApprovalAfterDeadline(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteApprovalAfterRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Approval after refresh", slowAppSource);
        yield* checkApprovalAfterRefresh(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteRefreshNotAwaited.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* hostedApp("Background refresh", refreshAppSource);
        yield* checkRefreshNotAwaited(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpExecuteUnavailableApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Unavailable app",
          }),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Needs account ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: accountAppSource }],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
          }).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "unavailable-app", {
          organization: actors.organization.id,
        });
        const root = `tools[${JSON.stringify(app.slug)}]`;
        const call = (label: string, file: string, code: string) =>
          Effect.gen(function* () {
            const result = yield* client.use(label, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            );
            yield* evidence.json(file, result.structuredContent);
            const failed = yield* Schema.decodeUnknownEffect(Failed)(result.structuredContent);
            const reason = failed.unavailableApps.find((entry) => entry.app === app.id)?.reason;
            return { error: failed.execution.error, reason };
          });
        // Without a profile, a call into the app says why instead of reporting an unknown tool.
        const unprofiled = yield* call(
          "Call a tool of an account app that has no profile",
          "no-profile-result.json",
          `return await ${root}.queries.read({});`,
        );
        // An app nobody has set up is not listed on every execute; only a call into it reports it.
        expect(unprofiled.reason).toBeUndefined();
        expect(unprofiled.error.kind).toBe("ToolFailure");
        expect(unprofiled.error.response?.code).toBe("AppProfileRequired");
        expect(unprofiled.error.message).toContain("you have no enabled profile for it");
        const profile = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/profiles`,
          { accounts: {}, idempotencyKey: randomUUID() },
        );
        expect(profile.status).toBe(200);
        const { id } = yield* body(Schema.Struct({ id: Schema.String }), profile);
        // With a profile but no selected account, the SDK's curated error reaches the caller.
        const unselected = yield* call(
          "Call a tool of an app whose account is not selected",
          "unselected-result.json",
          `return await ${root}.profiles[${JSON.stringify(id)}].queries.read({});`,
        );
        expect(unselected.reason ?? "").toContain(
          "This app needs an account that has not been selected yet.",
        );
        expect(unselected.error.kind).toBe("ToolFailure");
        expect(unselected.error.response?.code).toBe("AccountRequired");
        expect(unselected.error.message).toContain("Open Accounts");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.mcpExecuteServerRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          evidence = yield* Evidence;
        // Every path other than the gate's own routes answers 404, like a moved MCP server.
        const gate = yield* requestGate;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Refused MCP server",
          }),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Moved MCP ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } }),
            },
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";
import { mcpOperations } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => mcpOperations({ url: ${JSON.stringify(`${gate.origin}/moved/mcp`)} }));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
          }).pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "refused-mcp", {
          organization: actors.organization.id,
        });
        const code = `return await tools[${JSON.stringify(app.slug)}].queries.anything({});`;
        const started = yield* Clock.currentTimeMillis;
        const result = yield* client.use(
          "Call a tool of an app whose MCP server refuses connections",
          (client, signal) =>
            client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        yield* evidence.json("refused-result.json", { elapsed, result: result.structuredContent });
        const failed = yield* Schema.decodeUnknownEffect(Failed)(result.structuredContent);
        const reason = failed.unavailableApps.find((entry) => entry.app === app.id)?.reason ?? "";
        // The MCP server's refusal is named, instead of a generic tool-definition failure.
        expect(reason).toContain("refused the request while connecting (HTTP 404)");
        expect(failed.execution.error.kind).toBe("ToolFailure");
        expect(failed.execution.error.message).toContain("HTTP 404");
        // A deterministic refusal fails without waiting for a connection timeout.
        expect(elapsed).toBeLessThan(10_000);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local MCP execute failures", (it) => {
  it.effect(scenarios.localMcpExecuteTimeoutReport.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* localApp("Slow tools", slowAppSource);
        yield* checkTimeoutReport(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localMcpExecuteApprovalAfterRefresh.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* localApp("Approval after refresh", slowAppSource);
        yield* checkApprovalAfterRefresh(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.localMcpExecuteRefreshNotAwaited.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { client, slug } = yield* localApp("Background refresh", refreshAppSource);
        yield* checkRefreshNotAwaited(client, slug);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
