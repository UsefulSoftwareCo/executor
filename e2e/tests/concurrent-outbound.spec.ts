import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { emulatorRequest } from "../support/emulators.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const delayMs = 6_000;
const calls = 10;
const held = 5;
const heldMs = 8_000;

const Instance = Schema.Struct({ providerBaseUrl: Schema.String });
const Key = Schema.Struct({ credential: Schema.Struct({ token: Schema.String }) });
const Ledger = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      query: Schema.String,
      timestamp: Schema.String,
      faulted: Schema.optional(Schema.Boolean),
      request: Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
      identity: Schema.Struct({ user: Schema.optional(Schema.Unknown) }),
    }),
  ),
});
const Completed = <A>(value: Schema.Codec<A>) =>
  Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({ ok: Schema.Literal(true), value }),
  });
const Timed = Schema.Array(Schema.Struct({ status: Schema.Number, ms: Schema.Number }));
const Attempt = Schema.Struct({ status: Schema.Number, text: Schema.String, ms: Schema.Number });
const Checked = Schema.Struct({
  allowed: Attempt,
  forged: Attempt,
  foreign: Attempt,
  plain: Attempt,
  redirected: Attempt,
});
const Private = Schema.Struct({ address: Attempt, redirected: Attempt, allowed: Attempt });
const Refusal = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal("NetworkRefused"),
    host: Schema.String,
    refusal: Schema.Struct({ reason: Schema.String }),
  }),
);

const foreignHost = "foreign.concurrent-outbound.invalid";
const redirectedHost = "redirected.concurrent-outbound.invalid";

const source = (
  name: string,
) => `import { bearer, defineApp, defineProvider, number, object, query, router, secrets, string } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, hosts: ["emulators.dev"], auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) }),
} });
const placed = defineProvider({ name: ${JSON.stringify(`${name} placed`)}, hosts: ["emulators.dev"], auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }), request: ({ token }) => bearer(token) }),
} });
const attempt = async (started, url, init) => {
  try {
    const response = await fetch(url, init);
    return { status: response.status, text: await response.text(), ms: Date.now() - started };
  } catch (error) {
    return { status: 0, text: String(error), ms: Date.now() - started };
  }
};
const Behind = object({ service: string(), waiting: string(), waitingToken: string(), count: number() });
/** Fill the call's direct slots with requests that wait, then run the checked ones. */
const behind = async ({ waiting, waitingToken, count }, checks) => {
  const auth = { authorization: "Bearer " + waitingToken };
  const holding = Array.from({ length: count }, () => fetch(waiting + "/hold", { headers: auth }).then((response) => response.text()));
  // The held requests leave first; this call's own clock moves only across I/O.
  await fetch(waiting + "/ready", { headers: auth }).then((response) => response.text());
  const started = Date.now();
  const results = await checks(started);
  await Promise.all(holding);
  return results;
};
export default defineApp({ user: { accounts: { service, placed } } }, {
  tools: router({
    read: query({ input: object({ url: string() }) }, async ({ user: { accounts } }, { url }) => {
      const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + accounts.service.fields.token } });
      await response.text();
      return { status: response.status };
    }),
    checks: query({ input: Behind }, async ({ user: { accounts } }, input) => {
      const token = accounts.service.fields.token;
      const auth = { authorization: "Bearer " + token };
      return behind(input, async (started) => {
        const [allowed, forged, foreign, plain, redirected] = await Promise.all([
          attempt(started, input.service + "/allowed", { method: "POST", headers: auth }),
          // App code naming a group of its own changes nothing, and the name reaches no service.
          attempt(started, input.service + "/allowed?forged", { method: "POST", headers: { ...auth, "x-executor-outbound-group": "forged-by-app" } }),
          attempt(started, "https://${foreignHost}/foreign", { headers: auth }),
          attempt(started, input.service.replace("https://", "http://") + "/plain", { method: "POST", headers: accounts.placed.headers() }),
          // A header the redirect keeps carries the handle to the second hop.
          attempt(started, input.service + "/redirect", { method: "POST", headers: { "x-api-key": token } }),
        ]);
        return { allowed, forged, foreign, plain, redirected };
      });
    }),
    privateChecks: query({ input: Behind }, async ({ user: { accounts } }, input) => {
      const auth = { authorization: "Bearer " + accounts.service.fields.token };
      return behind(input, async (started) => {
        const [address, redirected, allowed] = await Promise.all([
          attempt(started, "http://10.0.0.1/private"),
          attempt(started, input.service + "/to-private", { method: "POST" }),
          attempt(started, input.service + "/allowed", { method: "POST", headers: auth }),
        ]);
        return { address, redirected, allowed };
      });
    }),
  }),
});`;

const setup = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    mcp = yield* McpClient,
    evidence = yield* Evidence;
  const emulator = Effect.gen(function* () {
    const instance = yield* emulatorRequest(
      "https://context.emulators.dev",
      "/_emulate/instances",
      {
        instance: `executor-concurrent-outbound-${randomUUID()}`,
      },
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Instance)));
    const key = yield* emulatorRequest(instance.providerBaseUrl, "/_emulate/credentials", {
      type: "api-key",
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Key)));
    return { origin: instance.providerBaseUrl, token: key.credential.token };
  });
  const { origin: service, token } = yield* emulator;
  const waiting = yield* emulator;
  const fault = (
    path: string,
    times: number,
    response: object,
    delay = 0,
    on: { readonly origin: string; readonly token: string } = { origin: service, token },
    method: "GET" | "POST" = "POST",
  ) =>
    emulatorRequest(
      on.origin,
      "/_emulate/faults",
      {
        match: { method, pathPattern: path },
        response,
        times,
        ...(delay > 0 ? { delayMs: delay } : {}),
      },
      on.token,
    );

  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Concurrent outbound ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source("Slow service") }, appsManifest],
  });
  yield* evidence.json("deploy.json", deployed);
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  const path = `${prefix}/apps/${app.id}`;
  const accounts: Array<string> = [];
  const apiKey = yield* body(
    Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "Concurrent outbound",
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", {
        keyId: apiKey.id,
      });
      yield* api.request(actors.owner, "DELETE", path);
      for (const account of accounts)
        yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
    }).pipe(Effect.orDie),
  );
  for (const requirement of ["service", "placed"]) {
    const connection = yield* body(
      Resource,
      yield* api.request(actors.owner, "POST", connectionsPath(path, "user", requirement), {}),
    );
    const saved = yield* api.request(
      actors.owner,
      "POST",
      `${prefix}/connections/${connection.id}/submit`,
      { method: "key", fields: { token } },
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    accounts.push((yield* body(Resource, saved)).id);
  }

  const client = yield* mcp.connect(apiKey.key, "concurrent-outbound", {
    organization: actors.organization.id,
  });
  const execute = <A>(label: string, value: Schema.Codec<A>, code: string) =>
    client
      .use(label, (client, signal) =>
        client.callTool({ name: "execute", arguments: { code } }, undefined, {
          signal,
          timeout: 55_000,
        }),
      )
      .pipe(
        Effect.tap((result) => evidence.json(`${label}.json`, result.structuredContent)),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Completed(value))(result.structuredContent),
        ),
        Effect.map((completed) => completed.execution.value),
      );
  const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
  yield* execute(
    "Call the app once",
    Timed,
    `return [{ ...(await ${tool("read")}({ url: ${JSON.stringify(`${service}/warm`)} })), ms: 0 }];`,
  );
  const ledger = (expected: Readonly<Record<string, number>> = {}) =>
    emulatorRequest(service, "/_emulate/ledger", undefined, token).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
      Effect.map((read) => read.entries),
      Effect.filterOrFail(
        (entries) =>
          Object.entries(expected).every(
            ([suffix, count]) =>
              entries.filter((entry) => entry.path.endsWith(suffix)).length >= count,
          ),
        () => new Error("The service's ledger does not hold every request yet"),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
    );
  const behind = { service, waiting: waiting.origin, waitingToken: waiting.token, count: held };
  const hold = Effect.all([
    fault("/hold", held, { status: 200, body: { held: true } }, heldMs, waiting, "GET"),
    fault("/ready", 1, { status: 200, body: { ready: true } }, 0, waiting, "GET"),
  ]);
  return { app, service, fault, hold, behind, execute, tool, ledger, evidence };
});

const executorHeaders = (entries: typeof Ledger.Type.entries) =>
  entries.flatMap((entry) =>
    Object.entries(entry.request.headers)
      .filter(([name]) => name.toLowerCase().startsWith("x-executor"))
      .map(([name, value]) => `${entry.path}${entry.query} ${name}: ${value}`),
  );
const forgedHeader = "/allowed?forged x-executor-outbound-group: forged-by-app";

const refusal = (attempt: typeof Attempt.Type) => {
  expect(attempt.status, attempt.text).toBe(421);
  return Schema.decodeUnknownSync(Refusal)(attempt.text);
};

layer(HostedLive, { excludeTestServices: true })("Concurrent outbound requests", (it) => {
  it.effect(scenarios.concurrentOutbound.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { app, service, fault, execute, tool, ledger, evidence } = yield* setup;
        yield* fault("/slow", calls, { status: 200, body: { ok: true } }, delayMs);
        const executed = yield* execute(
          `Call the slow service ${calls} times at once`,
          Timed,
          `return await Promise.all(Array.from({ length: ${calls} }, async () => {
  const started = Date.now();
  const { status } = await ${tool("read")}({ url: ${JSON.stringify(`${service}/slow`)} });
  return { status, ms: Date.now() - started };
}));`,
        );
        const entries = yield* ledger({ "/slow": calls });
        const slow = entries.filter((entry) => entry.path.endsWith("/slow"));
        const times = executed.map((call) => call.ms);
        yield* evidence.json("concurrent-calls.json", {
          delayMs,
          times,
          upstream: slow.map((entry) => ({
            received: entry.timestamp,
            faulted: entry.faulted ?? false,
            authenticated: entry.identity.user !== undefined,
          })),
        });
        expect(executed.map((call) => call.status)).toEqual(
          Array.from({ length: calls }, () => 200),
        );
        for (const ms of times) expect(ms).toBeLessThan(delayMs * 1.5);
        expect(slow).toHaveLength(calls);
        for (const entry of slow) {
          expect(entry.faulted).toBe(true);
          expect(entry.identity.user).toBeDefined();
        }
        expect(executorHeaders(entries)).toEqual([]);
        if ((yield* Target).metadata.target !== "cloud") return;
        const telemetry = yield* Telemetry;
        const routes = yield* telemetry
          .search("http.server POST", { app: app.id }, { "http.route": "/:upstream" })
          .pipe(
            Effect.map((found) =>
              found.data
                .map(({ span }) => span.tags)
                .filter((tags) => tags["executor.outbound.route"] !== undefined),
            ),
            Effect.filterOrFail(
              (tags) => tags.length >= calls + 1,
              () => new Error("Not every outbound request's span has arrived yet"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          );
        const sent = routes.map((tags) => ({
          route: tags["executor.outbound.route"],
          waited: Number(tags["executor.outbound.wait_ms"]),
        }));
        yield* evidence.json("routes.json", sent);
        expect(sent.filter((request) => request.route === "direct")).toEqual(
          Array.from({ length: 6 }, () => ({ route: "direct", waited: 0 })),
        );
        const relayed = sent.filter((request) => request.route === "relay");
        expect(relayed).toHaveLength(calls - 5);
        for (const request of relayed) expect(request.waited).toBeGreaterThanOrEqual(50);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.concurrentOutboundChecks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { fault, hold, behind, execute, tool, ledger, evidence } = yield* setup;
        yield* hold;
        yield* fault("/allowed", 2, { status: 200, body: { allowed: true } });
        yield* fault("/redirect", 1, {
          status: 302,
          headers: { location: `https://${redirectedHost}/landed` },
        });
        const checked = yield* execute(
          "Send checked requests while five others wait",
          Checked,
          `return await ${tool("checks")}(${JSON.stringify(behind)});`,
        );
        const entries = yield* ledger({ "/allowed": 2, "/redirect": 1 });
        yield* evidence.json("checked-requests.json", { checked, entries });

        for (const attempt of [checked.allowed, checked.forged, checked.redirected])
          expect(attempt.ms, attempt.text).toBeLessThan(heldMs / 2);
        expect(checked.allowed.status, checked.allowed.text).toBe(200);
        const allowed = entries.filter((entry) => entry.path.endsWith("/allowed"));
        expect(allowed).toHaveLength(2);
        for (const entry of allowed) expect(entry.identity.user).toBeDefined();
        expect(checked.forged.status, checked.forged.text).toBe(200);
        expect(refusal(checked.foreign)).toMatchObject({
          host: foreignHost,
          refusal: { reason: "credential_host" },
        });
        expect(refusal(checked.plain).refusal.reason).toBe("credential_transport");
        expect(entries.filter((entry) => entry.path.endsWith("/plain"))).toEqual([]);
        expect(refusal(checked.redirected)).toMatchObject({
          host: redirectedHost,
          refusal: { reason: "credential_host" },
        });
        expect(entries.filter((entry) => entry.path.endsWith("/redirect"))).toHaveLength(1);
        expect(executorHeaders(entries)).toEqual(
          (yield* Target).metadata.target === "cloud" ? [] : [forgedHeader],
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.concurrentOutboundPrivate.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { fault, hold, behind, execute, tool, ledger, evidence } = yield* setup;
        yield* hold;
        yield* fault("/allowed", 1, { status: 200, body: { allowed: true } });
        yield* fault("/to-private", 1, {
          status: 302,
          headers: { location: "http://10.0.0.2/landed" },
        });
        const checked = yield* execute(
          "Send requests to private addresses while five others wait",
          Private,
          `return await ${tool("privateChecks")}(${JSON.stringify(behind)});`,
        );
        const entries = yield* ledger({ "/allowed": 1, "/to-private": 1 });
        yield* evidence.json("private-requests.json", { checked, entries });
        expect(checked.allowed.status, checked.allowed.text).toBe(200);
        expect(checked.allowed.ms).toBeLessThan(heldMs / 2);
        expect(refusal(checked.address)).toMatchObject({
          host: "10.0.0.1",
          refusal: { reason: "private_address" },
        });
        expect(refusal(checked.redirected)).toMatchObject({
          host: "10.0.0.2",
          refusal: { reason: "private_address" },
        });
        expect(executorHeaders(entries)).toEqual([]);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
