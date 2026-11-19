/**
 * Calls one `execute` makes at once do not wait on one another for their outgoing requests.
 * Cloudflare lets one incoming request have six connections waiting for response headers and
 * queues the rest, counting every app call that request makes, so ten calls to a service that
 * takes several seconds to answer used to finish in two steps: six after one answer time, four
 * after two. Cloud keeps five of an incoming request's app requests on the direct network and sends
 * a request that finds no free slot within moments through a relay with its own limit, with the
 * same checks and credential substitution.
 *
 * The service is an emulators.dev instance that answers a path after `delayMs` when a fault says
 * so; it answers many such requests at once in one answer time. Its ledger records each request's
 * headers and whether it authenticated with the key the account holds, which only the host's
 * substitution of the app's credential handle sends. Hosts without the limit (self-host) answer
 * the same way without a relay.
 */
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

/** How long the service takes to answer each slow request. */
const delayMs = 6_000;
/** Calls the program makes at once: more than the six one request may have waiting. */
const calls = 10;
/** Requests that wait for the service while the checked ones are sent: every direct slot. */
const held = 5;
/** How long the held requests wait: the checked ones must finish well inside it. */
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
/** How one checked request ended, counted from when the checked requests started. */
const Attempt = Schema.Struct({ status: Schema.Number, text: Schema.String, ms: Schema.Number });
const Checked = Schema.Struct({
  allowed: Attempt,
  forged: Attempt,
  foreign: Attempt,
  plain: Attempt,
  redirected: Attempt,
});
const Private = Schema.Struct({ address: Attempt, redirected: Attempt, allowed: Attempt });
/** Executor's refusal of a request it never sent, as app code reads it. */
const Refusal = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal("NetworkRefused"),
    host: Schema.String,
    refusal: Schema.Struct({ reason: Schema.String }),
  }),
);

/** Hosts under the reserved `.invalid` suffix: nothing could answer a request that escaped a check. */
const foreignHost = "foreign.concurrent-outbound.invalid";
const redirectedHost = "redirected.concurrent-outbound.invalid";

/**
 * The service's key travels as the account's handle; the host puts the key in its place. `service`
 * may send it anywhere on its hosts; `placed` declares where it goes (`request`), which also keeps
 * it off plain HTTP. `behind` starts `count` requests that wait on a second emulator instance, so
 * every direct slot of the call is taken, then sends the checked requests to the service while they
 * wait, and returns how each ended.
 */
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

/** A private emulator instance, its key, the app deployed, an account connected and an MCP client. */
const setup = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    mcp = yield* McpClient,
    evidence = yield* Evidence;
  /** A new emulator instance and a key it accepts. */
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
  // The service the checked requests reach, and an instance that only keeps requests waiting.
  const { origin: service, token } = yield* emulator;
  const waiting = yield* emulator;
  /**
   * Answer `times` requests to `path` with `response`, after `delay` ms. The checked requests are
   * POSTs: the emulator stores its ledger after a request that may write, so their entries survive
   * the instance restarting before the ledger is read; it keeps a GET's entry in memory only.
   */
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
        // The program's whole answer goes in the evidence, so a failed call says why.
        Effect.tap((result) => evidence.json(`${label}.json`, result.structuredContent)),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Completed(value))(result.structuredContent),
        ),
        Effect.map((completed) => completed.execution.value),
      );
  const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
  // Start the app's Worker first, so the measured calls hold only their own requests.
  yield* execute(
    "Call the app once",
    Timed,
    `return [{ ...(await ${tool("read")}({ url: ${JSON.stringify(`${service}/warm`)} })), ms: 0 }];`,
  );
  /**
   * The service's ledger once it holds `expected` requests to the given paths: a request is
   * recorded after its answer, so the ledger is read again for a few seconds until it does.
   */
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
  /** The input the `checks` tools take. */
  const behind = { service, waiting: waiting.origin, waitingToken: waiting.token, count: held };
  /** Keep `held` requests waiting `heldMs` on the second instance. */
  const hold = Effect.all([
    fault("/hold", held, { status: 200, body: { held: true } }, heldMs, waiting, "GET"),
    fault("/ready", 1, { status: 200, body: { ready: true } }, 0, waiting, "GET"),
  ]);
  return { app, service, fault, hold, behind, execute, tool, ledger, evidence };
});

/** Every request the service received, with any header Executor uses to route app requests. */
const executorHeaders = (entries: typeof Ledger.Type.entries) =>
  entries.flatMap((entry) =>
    Object.entries(entry.request.headers)
      .filter(([name]) => name.toLowerCase().startsWith("x-executor"))
      .map(([name, value]) => `${entry.path}${entry.query} ${name}: ${value}`),
  );
/** The header app code set on its own request, which only a host that names groups removes. */
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
        // Every call finished in about one answer time: none waited for another's answer.
        for (const ms of times) expect(ms).toBeLessThan(delayMs * 1.5);
        // Each request reached the service once, carrying the account's key in place of its handle.
        expect(slow).toHaveLength(calls);
        for (const entry of slow) {
          expect(entry.faulted).toBe(true);
          expect(entry.identity.user).toBeDefined();
        }
        // The group the host names travels to its own network only.
        expect(executorHeaders(entries)).toEqual([]);
        if ((yield* Target).metadata.target !== "cloud") return;
        // On Cloud each request's span says how it was sent. The warm-up call's request and the
        // first five of the ten went direct at once; the other five found every slot waiting on
        // the slow service, waited for one, and were relayed.
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

        // Sent behind five waiting requests, each was answered long before those were.
        for (const attempt of [checked.allowed, checked.forged, checked.redirected])
          expect(attempt.ms, attempt.text).toBeLessThan(heldMs / 2);
        // The account's key replaced its handle on the request the provider allows.
        expect(checked.allowed.status, checked.allowed.text).toBe(200);
        const allowed = entries.filter((entry) => entry.path.endsWith("/allowed"));
        expect(allowed).toHaveLength(2);
        for (const entry of allowed) expect(entry.identity.user).toBeDefined();
        // A group app code names is not the host's: the request goes as any other. Cloud, which
        // names groups, removes the header; elsewhere it is the app's own header, sent as written.
        expect(checked.forged.status, checked.forged.text).toBe(200);
        // A host the provider does not declare and plain HTTP are refused before anything is sent.
        expect(refusal(checked.foreign)).toMatchObject({
          host: foreignHost,
          refusal: { reason: "credential_host" },
        });
        expect(refusal(checked.plain).refusal.reason).toBe("credential_transport");
        expect(entries.filter((entry) => entry.path.endsWith("/plain"))).toEqual([]);
        // The redirect's second hop comes back through the checks, which refuse the handle there.
        expect(refusal(checked.redirected)).toMatchObject({
          host: redirectedHost,
          refusal: { reason: "credential_host" },
        });
        expect(entries.filter((entry) => entry.path.endsWith("/redirect"))).toHaveLength(1);
        // No group the host named reached the service.
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
        // The request beside them that may go was answered long before the waiting ones were.
        expect(checked.allowed.status, checked.allowed.text).toBe(200);
        expect(checked.allowed.ms).toBeLessThan(heldMs / 2);
        // A private address is refused, sent directly or reached through a redirect.
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
