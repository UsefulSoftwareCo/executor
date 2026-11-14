/**
 * The tool call log: each hosted tool call made through the API, the dashboard or MCP is one row an
 * admin can find by the reference a failed call returns. It names who called which tool and how the
 * call ended, never what the caller sent or what the tool returned. Members read only their own.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors, password } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Inventory } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import {
  clientGrantId,
  ConnectionView,
  consentTo,
  scopedClientLogo,
} from "../support/mcp-connections.ts";
import { appsManifest } from "../support/apps-release.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { appAccountsFixture } from "../support/hosted-app-accounts.ts";
import { writeRows } from "../support/cloud-rows.ts";

const reference = /^call_[0-9a-hjkmnp-tv-z]{14}$/u;
const callLogNote =
  "Executor's reference for this tool call. Quote it to an organization admin, who can find the call in Executor's tool call log by searching for it.";

/**
 * Tools that succeed, throw, fail with a service's 403 and need approval. `echo` returns what it
 * was sent beside a result only this scenario's app holds; `explode` repeats what it was sent in its
 * error. Neither may reach the log.
 */
const appSource = (resultMarker: string) => `
import { defineApp, mutation, query, object, string, router, ProviderError } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ description: "Echo text", input: object({ text: string() }) },
    async (_, input) => ({ echoed: input.text, result: ${JSON.stringify(resultMarker)} })),
  explode: query({ description: "Fail with the text", input: object({ text: string() }) },
    async (_, input) => { throw new Error("The service refused " + input.text); }),
  forbidden: mutation({ description: "Fail with a 403", input: object({ text: string() }) },
    async () => { throw new ProviderError({ reason: "forbidden", status: 403 }); }),
  review: mutation({ description: "Needs approval", input: object({ text: string() }), approval: always() },
    async (_, input) => ({ reviewed: input.text })),
}) }));`;

const Person = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  member: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
});
/** The parts of a logged call these scenarios assert; the read API's contract has more. */
const Call = Schema.Struct({
  id: Schema.String,
  member: Schema.NullOr(Person),
  source: Schema.Struct({
    kind: Schema.String,
    id: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    icon: Schema.NullOr(Schema.String),
  }),
  connection: Schema.NullOr(
    Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
  session: Schema.NullOr(Schema.String),
  run: Schema.NullOr(Schema.Struct({ id: Schema.String, calls: Schema.Number })),
  app: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  tool: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  ),
  status: Schema.String,
  errorType: Schema.NullOr(Schema.String),
  statusCode: Schema.NullOr(Schema.Number),
  approval: Schema.NullOr(
    Schema.Struct({
      decision: Schema.String,
      decidedBy: Schema.NullOr(Person),
      decidedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
type Call = typeof Call.Type;
const Page = Schema.Struct({
  items: Schema.Array(Call),
  total: Schema.Number,
  totalCapped: Schema.Boolean,
});
/** A page as an agent reads it, with each call's start and running time. */
const AgentPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      ...Call.fields,
      startedAt: Schema.String,
      durationMs: Schema.NullOr(Schema.Number),
    }),
  ),
  total: Schema.Number,
});
const Filters = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String })),
  apps: Schema.Array(Schema.Struct({ id: Schema.String })),
  agents: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      icon: Schema.NullOr(Schema.String),
    }),
  ),
  connections: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  ),
});
const Viewer = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    image: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
/** A failure as `tools.call` returns it: the error's own fields and the call's reference. */
const Failure = Schema.Struct({
  _tag: Schema.String,
  message: Schema.optional(Schema.String),
  reference: Schema.optional(Schema.String),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const CallLog = Schema.Struct({ reference: Schema.String, note: Schema.String });
const ToolCalls = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    outcome: Schema.String,
    reference: Schema.optional(Schema.String),
  }),
);
/** One direct `call` that failed, with its reference beside the error. */
const FailedCall = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({
      path: Schema.String,
      ok: Schema.Literal(false),
      error: Schema.Struct({ kind: Schema.String, message: Schema.String }),
      callLog: CallLog,
    }),
    toolCalls: ToolCalls,
  }),
});
/** An `execute` program that returned a value. */
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const Caught = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  reference: Schema.optional(Schema.String),
});
const CompletedProgram = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({ caught: Caught }),
    toolCalls: ToolCalls,
  }),
});
const FailedProgram = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ message: Schema.String, callLog: Schema.optional(CallLog) }),
    toolCalls: ToolCalls,
  }),
});

/**
 * The owner deploys the fixture app and shares it with everyone, so every member may call it. The
 * scenario removes it when it ends.
 */
const deployLoggedApp = (resultMarker = `result-${randomUUID()}`) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Release desk ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: appSource(resultMarker) }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    const path = `${prefix}/apps/${app.id}`;
    yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
    const access = yield* body(
      Schema.Struct({ revision: Schema.String }),
      yield* api.request(actors.owner, "GET", `${path}/access`),
    );
    expect(
      (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
        revision: access.revision,
        audience: { kind: "everyone" },
      })).status,
    ).toBe(200);
    return { app, path, prefix, resultMarker };
  });

/** A personal API key for `actor`, deleted when the scenario ends. */
const apiKey = (actor: Session, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const key = yield* body(
      Key,
      yield* api.request(actor, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id }).pipe(Effect.orDie),
    );
    return {
      ...key,
      name,
      bearer: { authorization: `Bearer ${Redacted.value(key.key)}` },
    };
  });

const viewer = (actor: Session) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* body(Viewer, yield* api.request(actor, "GET", "/api/auth/get-session"))).user;
  });

/** The log's page for `query`, as `actor` reads it. */
const readLog = (actor: Session, query: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const search = new URLSearchParams(query).toString();
    const response = yield* api.request(
      actor,
      "GET",
      `/api/organizations/${actors.organization.id}/tool-calls${search === "" ? "" : `?${search}`}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { page: yield* body(Page, response), raw: JSON.stringify(response.body) };
  });
/**
 * The log's page for `query` once `done` holds. A call that succeeded is written after its response,
 * so its row can arrive a moment later; a failed call's row exists before its reference is returned.
 */
const readLogWhen = (
  actor: Session,
  query: Record<string, string>,
  done: (page: typeof Page.Type) => boolean,
) =>
  readLog(actor, query).pipe(
    Effect.repeat({ until: ({ page }) => done(page), schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("10 seconds"),
  );
/** The one call a reference names, as `actor` reads it. */
const findCall = (actor: Session, id: string, query: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const { page } = yield* readLog(actor, { ...query, search: id });
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual([id]);
    return page.items[0] as Call;
  });

const readFilters = (actor: Session) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const response = yield* api.request(
      actor,
      "GET",
      `/api/organizations/${actors.organization.id}/tool-calls/filters?range=30d`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { filters: yield* body(Filters, response), raw: JSON.stringify(response.body) };
  });

/** Call one MCP tool and keep its structured result as evidence. */
const mcpTool = (
  client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>,
  label: string,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence;
    const result = yield* client.use(label, (client, signal) =>
      client.callTool({ name, arguments: args }, undefined, { signal }),
    );
    yield* evidence.json(
      `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.json`,
      result.structuredContent,
    );
    return result.structuredContent;
  });

/** The fields of an error other than the reference, which must not repeat it. */
const withoutReference = (error: object) =>
  JSON.stringify(Object.fromEntries(Object.entries(error).filter(([key]) => key !== "reference")));

/**
 * A slow log: every row the organization writes takes 1.5 s, three times a failed call's bound.
 * `cloud` installs it in managed Cloud's database, otherwise in the stopped self-host's.
 */
const slowWrite = <E, R>(
  cloud: boolean,
  install: (
    statements: readonly [{ readonly sql: string }, ...{ readonly sql: string }[]],
  ) => Effect.Effect<unknown, E, R>,
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    if (!/^[A-Za-z0-9_-]+$/.test(actors.organization.id))
      return yield* Effect.die("Expected an organization ID");
    // Every row this organization writes takes 1.5 s, three times a failed call's bound.
    const slow: readonly [{ readonly sql: string }, ...{ readonly sql: string }[]] = [
      {
        sql: `CREATE FUNCTION e2e_tool_call_log_slow() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$`,
      },
      {
        sql: `CREATE TRIGGER e2e_tool_call_log_slow BEFORE INSERT ON hosted_tool_calls
          FOR EACH ROW WHEN (NEW.organization_id = '${actors.organization.id}')
          EXECUTE FUNCTION e2e_tool_call_log_slow()`,
      },
    ];
    yield* install(slow);
    const { app, path } = yield* deployLoggedApp();
    const key = yield* apiKey(actors.owner, `Slow log ${randomUUID().slice(0, 6)}`);
    const agent = yield* api.session();
    const call = (tool: string) =>
      Effect.gen(function* () {
        const started = performance.now();
        const response = yield* api.request(
          agent,
          "POST",
          `${path}/tools/call`,
          { tool, input: { text: "x" } },
          key.bearer,
        );
        return { response, ms: performance.now() - started };
      });

    // The app's first use starts its Worker, which can take longer than the bound on a busy
    // runner. Listing its tools, which writes no row, starts it before the calls are timed.
    const warmed = yield* api.request(agent, "GET", `${path}/tools`, undefined, key.bearer);
    expect(warmed.status, JSON.stringify(warmed.body)).toBe(200);

    // The call that succeeded answered before its row was written; the row follows.
    const succeeded = yield* call("echo");
    expect(succeeded.response.status).toBe(200);
    expect(succeeded.ms, "a successful call does not wait for its log write").toBeLessThan(1000);
    const logged = yield* readLogWhen(
      actors.owner,
      { app: app.id, range: "24h" },
      (page) => page.total >= 1,
    );
    expect(logged.page.items.map((item) => [item.tool, item.status])).toEqual([
      ["echo", "succeeded"],
    ]);

    const failed = yield* call("explode");
    const failure = yield* body(Failure, failed.response);
    expect(failure._tag).toBe("ToolCallFailed");
    if (cloud) {
      // A failed call waits for its row at most its bound, then answers without a reference.
      expect(failure.reference).toBeUndefined();
      expect(failed.ms, "a failed call waits at most its bound").toBeLessThan(1500);
    } else {
      // Self-host's database runs each statement on the server's own thread, so nothing can
      // stop waiting for it: the failed call answers once its row is written, with a reference
      // that leads to it.
      expect(failure.reference).toMatch(reference);
      expect(failed.ms).toBeGreaterThanOrEqual(1500);
      expect(yield* findCall(actors.owner, failure.reference ?? "")).toMatchObject({
        tool: "explode",
        status: "failed",
      });
    }
  });

/** No prune pass of the tool call log finished since the IDs a scenario recorded. */
class PruneNotFinished extends Schema.TaggedError<PruneNotFinished>()("PruneNotFinished", {}) {}
/** The span a finished prune pass of the tool call log records, from `pruneToolCallLog`. */
const prunePass = "product.tool_call_log.prune";

layer(HostedLive, { excludeTestServices: true })("Tool call log", (it) => {
  it.effect(scenarios.toolCallLogReference.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app, path } = yield* deployLoggedApp();
        const member = yield* viewer(actors.member);
        // The log shows a current member's own picture beside their calls.
        const picture = `https://avatars.example.test/${randomUUID()}.png`;
        yield* Effect.acquireRelease(
          api.request(actors.member, "POST", "/api/auth/update-user", { image: picture }),
          () =>
            api
              .request(actors.member, "POST", "/api/auth/update-user", {
                image: member.image ?? null,
              })
              .pipe(Effect.orDie),
        );
        const key = yield* apiKey(actors.member, `Release bot ${randomUUID().slice(0, 6)}`);
        const agent = yield* api.session();
        const argumentMarker = `argument-${randomUUID()}`;
        const call = (tool: string) =>
          api.request(
            agent,
            "POST",
            `${path}/tools/call`,
            { tool, input: { text: argumentMarker } },
            key.bearer,
          );

        // A successful call returns the tool's value and no reference.
        const succeeded = yield* call("echo");
        expect(succeeded.status, JSON.stringify(succeeded.body)).toBe(200);
        expect(JSON.stringify(succeeded.body)).toContain(argumentMarker);
        expect(JSON.stringify(succeeded.body)).not.toMatch(/call_[0-9a-z]{14}/u);

        // A failed call returns its reference beside the error, never inside it.
        const thrown = yield* call("explode");
        expect(thrown.status, JSON.stringify(thrown.body)).toBeGreaterThanOrEqual(400);
        const failure = yield* body(Failure, thrown);
        expect(failure.reference).toMatch(reference);
        const ref = failure.reference ?? "";
        expect(failure._tag).toBe("ToolCallFailed");
        expect(withoutReference(failure)).not.toContain(ref);
        const refused = yield* call("forbidden");
        const forbidden = yield* body(Failure, refused);
        expect(forbidden.reference).toMatch(reference);
        expect(forbidden.reference).not.toBe(ref);
        expect(withoutReference(forbidden)).not.toContain(forbidden.reference ?? "");

        // An admin finds exactly that call by its reference, whatever else the query names.
        const found = yield* findCall(actors.admin, ref);
        expect(found).toMatchObject({
          member: { id: member.id, name: member.name, email: member.email, image: picture },
          // Only an agent's client has a logo.
          source: { kind: "api-key", id: key.id, name: key.name, icon: null },
          connection: null,
          session: null,
          run: null,
          app: { id: app.id, name: app.name },
          tool: "explode",
          kind: "query",
          status: "failed",
          errorType: "ToolCallFailed",
          statusCode: null,
          approval: null,
        });
        expect(
          yield* findCall(actors.admin, ref, { status: "succeeded", range: "24h", tool: "echo" }),
        ).toMatchObject({ id: ref });
        expect(yield* findCall(actors.owner, forbidden.reference ?? "")).toMatchObject({
          tool: "forbidden",
          kind: "mutation",
          status: "failed",
          statusCode: 403,
        });

        // The successful call is logged too, under the same key.
        const all = yield* readLogWhen(
          actors.admin,
          { app: app.id, range: "30d" },
          (page) => page.total >= 3,
        );
        expect(all.page.total).toBe(3);
        expect(
          all.page.items.map((item) => [item.tool, item.status, item.source.id]).sort(),
        ).toEqual([
          ["echo", "succeeded", key.id],
          ["explode", "failed", key.id],
          ["forbidden", "failed", key.id],
        ]);
        expect(all.page.items.find((item) => item.tool === "echo")?.errorType).toBeNull();

        // A tool the app does not have is logged with its failure but not its name, which was only
        // the caller's own text.
        const unknownName = `missing-${randomUUID()}`;
        const unknown = yield* body(Failure, yield* call(unknownName));
        expect(unknown._tag).toBe("ToolNotFound");
        expect(unknown.reference).toMatch(reference);
        const unknownRow = yield* findCall(actors.admin, unknown.reference ?? "");
        expect(unknownRow).toMatchObject({
          tool: null,
          status: "failed",
          errorType: "ToolNotFound",
        });
        const unknownRaw = (yield* readLog(actors.admin, { search: unknown.reference ?? "" })).raw;
        expect(unknownRaw).not.toContain(unknownName);

        // A call refused before the app's tools are read, here for a version the app does not
        // have, still says which tool it was for.
        const stale = yield* body(
          Failure,
          yield* api.request(
            agent,
            "POST",
            `${path}/tools/call`,
            { tool: "echo", input: { text: argumentMarker }, version: `dpl_${randomUUID()}` },
            key.bearer,
          ),
        );
        expect(stale._tag).toBe("VersionNotFound");
        expect(stale.reference).toMatch(reference);
        expect(yield* findCall(actors.admin, stale.reference ?? "")).toMatchObject({
          tool: "echo",
          status: "failed",
          errorType: "VersionNotFound",
        });

        // Neither the caller's arguments nor the tool's result or error text reach the log.
        const { raw: filters } = yield* readFilters(actors.admin);
        for (const [label, raw] of [
          ["list", all.raw],
          ["reference search", (yield* readLog(actors.admin, { search: ref })).raw],
          ["filters", filters],
        ] as const) {
          expect(raw, label).not.toContain(argumentMarker);
          expect(raw, label).not.toContain("result-");
          expect(raw, label).not.toContain("The service refused");
        }
      }),
    ),
  );

  it.effect(scenarios.toolCallLogMcp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          mcp = yield* McpClient;
        const { app } = yield* deployLoggedApp();
        const owner = yield* viewer(actors.owner);
        const key = yield* apiKey(actors.owner, `MCP key ${randomUUID().slice(0, 6)}`);
        const client = yield* mcp.connect(key.key, "tool-call-log", {
          organization: actors.organization.id,
        });
        const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
        const marker = `argument-${randomUUID()}`;

        // A failed `call` keeps the service's error and adds the reference beside it.
        const called = yield* Schema.decodeUnknownEffect(FailedCall)(
          yield* mcpTool(client, "Call a failing tool", "call", {
            calls: { path: tool("explode"), input: { text: marker } },
          }),
        );
        const outcome = called.execution.value;
        expect(outcome.callLog.reference).toMatch(reference);
        expect(outcome.callLog.note).toBe(callLogNote);
        expect(outcome.error.message).toContain(`The service refused ${marker}`);
        expect(JSON.stringify(outcome.error)).not.toContain(outcome.callLog.reference);
        expect(called.execution.toolCalls).toEqual([
          expect.objectContaining({
            name: tool("explode"),
            outcome: "failure",
            reference: outcome.callLog.reference,
          }),
        ]);
        const direct = yield* findCall(actors.admin, outcome.callLog.reference);
        expect(direct).toMatchObject({
          member: { id: owner.id },
          source: { kind: "api-key", id: key.id, name: key.name },
          tool: "explode",
          status: "failed",
          errorType: "ToolCallFailed",
          run: { calls: 1 },
        });

        // One program's calls share a run. A caught failure keeps its name and message and adds
        // its reference; successful calls carry none.
        const program = yield* Schema.decodeUnknownEffect(CompletedProgram)(
          yield* mcpTool(client, "Run a program with a caught failure", "execute", {
            code: `
await ${tool("echo")}({ text: "one" });
await ${tool("echo")}({ text: "two" });
try {
  await ${tool("explode")}({ text: ${JSON.stringify(marker)} });
  return { caught: { name: "none", message: "none" } };
} catch (error) {
  return { caught: { name: error.name, message: error.message, reference: error.reference } };
}`,
          }),
        );
        const caught = program.execution.value.caught;
        expect(caught.reference).toMatch(reference);
        expect(caught.message).toContain(`The service refused ${marker}`);
        expect(caught.message).not.toContain(caught.reference ?? "");
        expect(caught.name).not.toBe("none");
        expect(
          program.execution.toolCalls.map((entry) => [entry.outcome, entry.reference]),
        ).toEqual([
          ["success", undefined],
          ["success", undefined],
          ["failure", caught.reference],
        ]);
        const caughtRow = yield* findCall(actors.admin, caught.reference ?? "");
        const run = yield* readLogWhen(
          actors.admin,
          { run: caughtRow.run?.id ?? "" },
          (page) => page.total >= 3,
        );
        expect((yield* findCall(actors.admin, caught.reference ?? "")).run?.calls).toBe(3);
        expect(run.page.items.map((item) => [item.tool, item.status]).reverse()).toEqual([
          ["echo", "succeeded"],
          ["echo", "succeeded"],
          ["explode", "failed"],
        ]);
        expect(caughtRow.run?.id).not.toBe(direct.run?.id);

        // An uncaught failure puts the reference on the program's failure.
        const failed = yield* Schema.decodeUnknownEffect(FailedProgram)(
          yield* mcpTool(client, "Run a program that fails", "execute", {
            code: `await ${tool("echo")}({ text: "first" });
return await ${tool("explode")}({ text: ${JSON.stringify(marker)} });`,
          }),
        );
        const uncaught = failed.execution.error.callLog;
        expect(uncaught?.reference).toMatch(reference);
        expect(uncaught?.note).toBe(callLogNote);
        expect(failed.execution.error.message).not.toContain(uncaught?.reference ?? "");
        expect(failed.execution.toolCalls.at(-1)?.reference).toBe(uncaught?.reference);
        const uncaughtRow = yield* findCall(actors.admin, uncaught?.reference ?? "");
        yield* readLogWhen(
          actors.admin,
          { run: uncaughtRow.run?.id ?? "" },
          (page) => page.total >= 2,
        );
        expect(yield* findCall(actors.admin, uncaught?.reference ?? "")).toMatchObject({
          tool: "explode",
          status: "failed",
          run: { calls: 2 },
        });

        // Every request on this session-carrying revision names the same MCP session, and
        // another connection is another session.
        const session = direct.session;
        expect(session).toEqual(expect.any(String));
        for (const row of [caughtRow, uncaughtRow]) expect(row.session).toBe(session);
        const sessionCalls = yield* readLogWhen(
          actors.admin,
          { session: session ?? "" },
          (page) => page.total >= 6,
        );
        expect(sessionCalls.page.total).toBe(6);
        expect(sessionCalls.raw).not.toContain(marker);
        const other = yield* mcp.connect(key.key, "tool-call-log-other", {
          organization: actors.organization.id,
        });
        const again = yield* Schema.decodeUnknownEffect(FailedCall)(
          yield* mcpTool(other, "Call a failing tool on another connection", "call", {
            calls: { path: tool("explode"), input: { text: "other" } },
          }),
        );
        const otherRow = yield* findCall(actors.admin, again.execution.value.callLog.reference);
        expect(otherRow.session).toEqual(expect.any(String));
        expect(otherRow.session).not.toBe(session);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogScopedAgent.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const { app, prefix } = yield* deployLoggedApp();
        const admin = yield* viewer(actors.admin);
        const name = `Release automation ${randomUUID().slice(0, 6)}`;
        const created = yield* api.request(actors.admin, "POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name,
          apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        const consent = yield* consentTo(actors.admin, connection.url);
        const grant = yield* clientGrantId(actors.admin, consent.clientId);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.admin, "POST", "/api/auth/mcp/grants/revoke", { id: grant })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(yield* consent.tokens, "scoped-agent", {
          connection: connection.id,
        });
        const tool = (tool: string) => `tools[${JSON.stringify(app.slug)}].${tool}`;
        const ran = yield* mcpTool(client, "The agent runs a program", "execute", {
          code: `await ${tool("echo")}({ text: "agent" });
try { await ${tool("forbidden")}({ text: "agent" }); } catch {}
return "done";`,
        });
        expect(ran).toMatchObject({ status: "completed", execution: { ok: true, value: "done" } });
        // The connection does not include the Executor app, so its agent cannot read the log.
        const read = yield* mcpTool(client, "The agent tries to read the log", "execute", {
          code: `try { await tools.executor.toolCalls.list(${JSON.stringify({ path: { organization: actors.organization.id }, query: {} })}); return "read"; }
catch { return "refused"; }`,
        });
        expect(read).toMatchObject({ execution: { ok: true, value: "refused" } });

        const byAgent = yield* readLogWhen(
          actors.owner,
          { agent: grant },
          (page) => page.total >= 2,
        );
        expect(byAgent.page.items.map((item) => [item.tool, item.status]).sort()).toEqual([
          ["echo", "succeeded"],
          ["forbidden", "failed"],
        ]);
        for (const item of byAgent.page.items)
          expect(item).toMatchObject({
            member: { id: admin.id },
            // The logo is the client's registered one, read through the grant.
            source: {
              kind: "agent",
              id: grant,
              name: "Scoped connection client",
              icon: scopedClientLogo,
            },
            connection: { id: connection.id, name },
            run: { calls: 2 },
          });
        const byConnection = yield* readLog(actors.owner, { connection: connection.id });
        expect(byConnection.page.items.map((item) => item.id).sort()).toEqual(
          byAgent.page.items.map((item) => item.id).sort(),
        );
        const { filters } = yield* readFilters(actors.owner);
        expect(filters.agents).toContainEqual({
          source: "agent",
          id: grant,
          name: "Scoped connection client",
          icon: scopedClientLogo,
        });
        expect(filters.connections).toContainEqual({ id: connection.id, name });
      }).pipe(Effect.provide(Layer.mergeAll(McpClient.layer))),
    ),
  );

  it.effect(scenarios.toolCallLogApprovals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const { app, path } = yield* deployLoggedApp();
        const [owner, member] = yield* Effect.all([viewer(actors.owner), viewer(actors.member)]);
        const run = (actor: Session, text: string) =>
          api
            .request(actor, "POST", `${path}/tools/run`, {
              tool: "review",
              kind: "mutation",
              input: { text },
            })
            .pipe(Effect.flatMap((response) => body(Pending, response)));
        const approved = yield* run(actors.owner, "approve me");
        const declined = yield* run(actors.member, "decline me");

        // Each call waiting for approval is one row, listed as needing approval.
        const waiting = yield* readLog(actors.admin, {
          tool: "review",
          status: "awaiting-approval",
        });
        expect(waiting.page.total).toBe(2);
        for (const item of waiting.page.items)
          expect(item).toMatchObject({
            source: { kind: "dashboard", id: null },
            status: "awaiting-approval",
            approval: { decision: "pending", decidedBy: null, decidedAt: null },
          });
        const rowOf = (user: string) =>
          waiting.page.items.find((item) => item.member?.id === user)?.id ?? "";
        const approvedId = rowOf(owner.id);
        const declinedId = rowOf(member.id);
        expect(approvedId).toMatch(reference);
        expect(declinedId).toMatch(reference);

        // Approving runs the call; the same row reads as succeeded, with who approved.
        const answer = (actor: Session, requestId: string, action: "accept" | "decline") =>
          api.request(actor, "POST", `${path}/tools/approvals/${requestId}`, {
            response: action === "accept" ? { action, content: {} } : { action },
          });
        expect((yield* answer(actors.owner, approved.requestId, "accept")).body).toEqual({
          status: "answered",
          result: { status: "completed", value: { reviewed: "approve me" } },
        });
        // The approved call succeeded, so its row is updated after the answer's response.
        yield* readLogWhen(actors.admin, { tool: "review", status: "succeeded" }, (page) =>
          page.items.some((item) => item.id === approvedId),
        );
        expect(yield* findCall(actors.admin, approvedId)).toMatchObject({
          status: "succeeded",
          member: { id: owner.id },
          approval: { decision: "approved", decidedBy: { id: owner.id, name: owner.name } },
        });

        // Declining returns the call's reference; the same row reads as denied.
        expect((yield* answer(actors.member, declined.requestId, "decline")).body).toEqual({
          status: "answered",
          result: { status: "denied", requestId: declined.requestId },
          reference: declinedId,
        });
        expect(yield* findCall(actors.admin, declinedId)).toMatchObject({
          status: "denied",
          member: { id: member.id },
          approval: { decision: "denied", decidedBy: { id: member.id } },
        });
        // Answering again finds the request gone: only the call that did not succeed is named.
        expect((yield* answer(actors.owner, approved.requestId, "accept")).body).toEqual({
          status: "unavailable",
        });
        expect((yield* answer(actors.member, declined.requestId, "accept")).body).toEqual({
          status: "unavailable",
          reference: declinedId,
        });

        // An MCP call that pauses for approval and is resumed is one row too.
        const key = yield* apiKey(actors.owner, `Approvals ${randomUUID().slice(0, 6)}`);
        const client = yield* mcp.connect(key.key, "approvals", {
          organization: actors.organization.id,
        });
        const paused = yield* Schema.decodeUnknownEffect(Pending)(
          yield* mcpTool(client, "Call a tool that needs approval", "call", {
            calls: { path: `tools[${JSON.stringify(app.slug)}].review`, input: { text: "mcp" } },
          }),
        );
        const mcpWaiting = yield* readLog(actors.admin, { tool: "review", agent: key.id });
        expect(mcpWaiting.page.items.map((item) => item.status)).toEqual(["awaiting-approval"]);
        const mcpId = mcpWaiting.page.items[0]?.id ?? "";
        expect(
          yield* mcpTool(client, "Approve the call", "resume", {
            requestId: paused.requestId,
            response: { action: "accept" },
          }),
        ).toMatchObject({ status: "completed", execution: { ok: true } });
        yield* readLogWhen(actors.admin, { tool: "review", status: "succeeded" }, (page) =>
          page.items.some((item) => item.id === mcpId),
        );
        expect(yield* findCall(actors.admin, mcpId)).toMatchObject({
          status: "succeeded",
          source: { kind: "api-key", id: key.id },
          approval: { decision: "approved", decidedBy: { id: owner.id } },
        });

        // Three calls, three rows: answering never adds one.
        const all = yield* readLog(actors.admin, { tool: "review" });
        expect(all.page.total).toBe(3);
        expect(all.page.items.map((item) => item.id).sort()).toEqual(
          [approvedId, declinedId, mcpId].sort(),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogAuthorization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        const { app, path } = yield* deployLoggedApp();
        const [owner, member] = yield* Effect.all([viewer(actors.owner), viewer(actors.member)]);
        const ownerKey = yield* apiKey(actors.owner, `Owner key ${randomUUID().slice(0, 6)}`);
        const memberKey = yield* apiKey(actors.member, `Member key ${randomUUID().slice(0, 6)}`);

        // The owner's calls come from one MCP program, so they carry a run and a session.
        const client = yield* mcp.connect(ownerKey.key, "owner-program", {
          organization: actors.organization.id,
        });
        const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
        const program = yield* Schema.decodeUnknownEffect(CompletedProgram)(
          yield* mcpTool(client, "The owner runs a program", "execute", {
            code: `await ${tool("echo")}({ text: "owner" });
try { await ${tool("explode")}({ text: "owner" }); return { caught: { name: "none", message: "none" } }; }
catch (error) { return { caught: { name: error.name, message: error.message, reference: error.reference } }; }`,
          }),
        );
        const ownerRef = program.execution.value.caught.reference ?? "";
        expect(ownerRef).toMatch(reference);
        const ownerRow = yield* findCall(actors.admin, ownerRef);
        expect(ownerRow.member?.id).toBe(owner.id);

        // The member's calls come from their own API key.
        const agent = yield* api.session();
        const memberCall = yield* api.request(
          agent,
          "POST",
          `${path}/tools/call`,
          { tool: "explode", input: { text: "member" } },
          memberKey.bearer,
        );
        const memberRef = (yield* body(Failure, memberCall)).reference ?? "";
        expect(memberRef).toMatch(reference);

        // A member reads only their own calls, whatever they filter by.
        const own = yield* readLog(actors.member, { range: "30d" });
        expect(own.page.items.map((item) => item.id)).toEqual([memberRef]);
        expect(yield* findCall(actors.member, memberRef)).toMatchObject({
          member: { id: member.id },
        });
        for (const [label, query] of [
          ["another member", { member: owner.id }],
          ["another member's reference", { search: ownerRef }],
          ["another member's run", { run: ownerRow.run?.id ?? "" }],
          ["another member's session", { session: ownerRow.session ?? "" }],
          ["another member's key", { agent: ownerKey.id }],
        ] as const) {
          const { page } = yield* readLog(actors.member, query);
          expect(page, label).toMatchObject({ items: [], total: 0 });
        }
        const memberFilters = (yield* readFilters(actors.member)).filters;
        expect(memberFilters.members.map((item) => item.id)).toEqual([member.id]);
        expect(memberFilters.agents.map((item) => item.id)).toEqual([memberKey.id]);

        // Owners and admins see both.
        for (const actor of [actors.owner, actors.admin]) {
          const all = yield* readLogWhen(actor, { range: "30d" }, (page) => page.total >= 3);
          expect(new Set(all.page.items.map((item) => item.member?.id))).toEqual(
            new Set([owner.id, member.id]),
          );
          expect(yield* findCall(actor, memberRef)).toMatchObject({ member: { id: member.id } });
          expect(
            (yield* readLog(actor, { member: member.id })).page.items.map((item) => item.id),
          ).toEqual([memberRef]);
          const filters = (yield* readFilters(actor)).filters;
          expect(filters.members.map((item) => item.id).sort()).toEqual(
            [owner.id, member.id].sort(),
          );
        }

        // An API key reads the log as the person who holds it: the member's key only their own
        // calls, the owner's every call.
        const asKey = (key: typeof memberKey, route: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              agent,
              "GET",
              `/api/organizations/${actors.organization.id}/${route}`,
              undefined,
              key.bearer,
            );
            expect(response.status, `${route} with a bearer key`).toBe(200);
            return response;
          });
        const memberKeyLog = yield* body(Page, yield* asKey(memberKey, "tool-calls?range=30d"));
        expect(memberKeyLog.items.map((item) => item.id)).toEqual([memberRef]);
        expect(
          (yield* body(Page, yield* asKey(memberKey, `tool-calls?search=${ownerRef}`))).total,
        ).toBe(0);
        expect(
          (yield* body(
            Filters,
            yield* asKey(memberKey, "tool-calls/filters?range=30d"),
          )).members.map((item) => item.id),
        ).toEqual([member.id]);
        const ownerKeyLog = yield* body(Page, yield* asKey(ownerKey, "tool-calls?range=30d"));
        expect(new Set(ownerKeyLog.items.map((item) => item.member?.id))).toEqual(
          new Set([owner.id, member.id]),
        );
        expect(
          (yield* body(Filters, yield* asKey(ownerKey, "tool-calls/filters?range=30d"))).members
            .map((item) => item.id)
            .sort(),
        ).toEqual([owner.id, member.id].sort());
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogAgentReads.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          target = yield* Target;
        const organization = actors.organization.id;
        const { app, path } = yield* deployLoggedApp();
        const [owner, member] = yield* Effect.all([viewer(actors.owner), viewer(actors.member)]);
        // Owners and admins get a managed key linked to the Executor app; a member links their own.
        const memberKey = yield* apiKey(actors.member, `Member agent ${randomUUID().slice(0, 6)}`);
        const executorApp = (yield* body(
          Inventory,
          yield* api.request(actors.member, "GET", `/api/organizations/${organization}/inventory`),
        )).apps.find((item) => item.slug === "executor");
        if (executorApp === undefined) return yield* Effect.die("The Executor app is missing");
        const pending = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(
            actors.member,
            "POST",
            connectionsPath(
              `/api/organizations/${organization}/apps/${executorApp.id}`,
              "user",
              "service",
            ),
            {},
          ),
        );
        const linked = yield* api.request(
          actors.member,
          "POST",
          `/api/organizations/${organization}/connections/${pending.id}/submit`,
          {
            method: "apiKey",
            label: "Member agent key",
            fields: { token: Redacted.value(memberKey.key), organization },
          },
        );
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);
        const memberAccount = yield* body(Schema.Struct({ id: Schema.String }), linked);
        yield* Effect.addFinalizer(() =>
          api
            .request(
              actors.member,
              "DELETE",
              `/api/organizations/${organization}/accounts/${memberAccount.id}`,
            )
            .pipe(Effect.orDie),
        );

        // The owner's call comes from their API key.
        const ownerKey = yield* apiKey(actors.owner, `Owner key ${randomUUID().slice(0, 6)}`);
        const ownerCall = yield* api.request(
          yield* api.session(),
          "POST",
          `${path}/tools/call`,
          { tool: "explode", input: { text: "owner" } },
          ownerKey.bearer,
        );
        const ownerRef = (yield* body(Failure, ownerCall)).reference ?? "";
        expect(ownerRef).toMatch(reference);

        /** An agent signed in over MCP OAuth as `actor`, with every tool. */
        const agentFor = (actor: Session, label: string) =>
          Effect.gen(function* () {
            const consent = yield* consentTo(actor, `${targetHosts(target).mcp}/mcp`, {
              "x-executor-organization": organization,
            });
            expect(consent.status).toBe(200);
            const token = yield* consent.tokens;
            const grant = yield* clientGrantId(actor, consent.clientId);
            yield* Effect.addFinalizer(() =>
              api
                .request(actor, "POST", "/api/auth/mcp/grants/revoke", { id: grant })
                .pipe(Effect.orDie),
            );
            const client = yield* mcp.connect(token, label);
            /** Run a program and return its value; it must complete. */
            const run = (step: string, code: string) =>
              Effect.gen(function* () {
                const result = yield* mcpTool(client, step, "execute", { code });
                return (yield* Schema.decodeUnknownEffect(Completed)(result)).execution.value;
              });
            return { grant, run };
          });
        const listed = (query: Record<string, string>) =>
          `return await tools.executor.toolCalls.list(${JSON.stringify({ path: { organization }, query })});`;
        const filtered = `return await tools.executor.toolCalls.filters(${JSON.stringify({ path: { organization }, query: { range: "24h" } })});`;

        // The member's agent calls the app, then reads its member's calls back.
        const memberAgent = yield* agentFor(actors.member, "member-agent");
        const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
        expect(
          yield* memberAgent.run(
            "The member's agent calls the app",
            `await ${tool("echo")}({ text: "member" });
try { await ${tool("explode")}({ text: "member" }); } catch {}
return "done";`,
          ),
        ).toBe("done");
        // The succeeded call's row follows its response.
        yield* readLogWhen(actors.admin, { app: app.id, range: "24h" }, (page) => page.total >= 3);

        const own = yield* Schema.decodeUnknownEffect(AgentPage)(
          yield* memberAgent.run(
            "The member's agent reads the log",
            listed({ app: app.id, range: "24h" }),
          ),
        );
        expect(own.items.map((item) => [item.tool, item.status]).sort()).toEqual([
          ["echo", "succeeded"],
          ["explode", "failed"],
        ]);
        for (const item of own.items) {
          expect(item).toMatchObject({
            member: { id: member.id },
            source: { kind: "agent", id: memberAgent.grant, name: "Scoped connection client" },
            app: { id: app.id, name: app.name },
          });
          expect(item.durationMs, `${item.tool} has a running time`).toEqual(expect.any(Number));
          expect(item.durationMs ?? -1).toBeGreaterThanOrEqual(0);
          expect(Number.isNaN(Date.parse(item.startedAt))).toBe(false);
        }
        // The owner's call is not the member's agent's to see, even by its reference.
        expect(
          yield* Schema.decodeUnknownEffect(AgentPage)(
            yield* memberAgent.run(
              "The member's agent searches for the owner's call",
              listed({ search: ownerRef }),
            ),
          ),
        ).toMatchObject({ items: [], total: 0 });
        const memberFilters = yield* Schema.decodeUnknownEffect(Filters)(
          yield* memberAgent.run("The member's agent reads the filters", filtered),
        );
        expect(memberFilters.members.map((item) => item.id)).toEqual([member.id]);

        // The admin's agent reads everyone's calls.
        const adminAgent = yield* agentFor(actors.admin, "admin-agent");
        const all = yield* Schema.decodeUnknownEffect(AgentPage)(
          yield* adminAgent.run(
            "The admin's agent reads the log",
            listed({ app: app.id, range: "24h" }),
          ),
        );
        expect(all.items.map((item) => [item.member?.id, item.tool, item.status]).sort()).toEqual(
          [
            [member.id, "echo", "succeeded"],
            [member.id, "explode", "failed"],
            [owner.id, "explode", "failed"],
          ].sort(),
        );
        expect(all.items.map((item) => item.id)).toContain(ownerRef);
        const adminFilters = yield* Schema.decodeUnknownEffect(Filters)(
          yield* adminAgent.run("The admin's agent reads the filters", filtered),
        );
        expect(adminFilters.members.map((item) => item.id)).toEqual(
          expect.arrayContaining([owner.id, member.id]),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.toolCallLogExpiry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { path } = yield* deployLoggedApp();
        const minute = 60_000,
          day = 24 * 60 * minute;
        const pending = yield* body(
          Pending,
          yield* api.request(actors.owner, "POST", `${path}/tools/run`, {
            tool: "review",
            kind: "mutation",
            input: { text: "lapses" },
          }),
        );
        const waiting = yield* readLog(actors.owner, { tool: "review" });
        expect(waiting.page.items.map((item) => item.status)).toEqual(["awaiting-approval"]);
        const lapsed = waiting.page.items[0]?.id ?? "";
        const old = (yield* body(
          Failure,
          yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "explode",
            input: { text: "old" },
          }),
        )).reference;
        expect(old).toMatch(reference);

        // Past its deadline the approval reads as expired before anything marks the row.
        yield* serverControl("clock/advance", 200, { milliseconds: 16 * minute });
        expect(yield* findCall(actors.owner, lapsed)).toMatchObject({
          status: "expired",
          approval: { decision: "expired", decidedBy: null },
        });
        expect(
          (yield* readLog(actors.owner, { tool: "review", status: "awaiting-approval" })).page
            .total,
        ).toBe(0);
        // Answering it then is refused, and names the call.
        expect(
          (yield* api.request(
            actors.owner,
            "POST",
            `${path}/tools/approvals/${pending.requestId}`,
            {
              response: { action: "accept", content: {} },
            },
          )).body,
        ).toEqual({ status: "unavailable", reference: lapsed });

        // The prune passes that have finished, by their span: the server forks one at each start,
        // and its span ends only once the pass has marked and deleted what it will.
        const telemetry = yield* Telemetry;
        const passes = telemetry
          .searchWholeEnvironment(prunePass, {})
          .pipe(
            Effect.map(
              ({ data }) =>
                new Set(
                  data.filter(({ span }) => span.status === "ok").map(({ span }) => span.spanId),
                ),
            ),
          );
        /**
         * Wait for a prune pass that had not finished at `before`, and fail at 30 seconds whatever
         * the cause, an unreadable collector included.
         */
        const nextPass = (before: ReadonlySet<string>) =>
          passes.pipe(
            Effect.flatMap((after) =>
              [...after].some((id) => !before.has(id))
                ? Effect.void
                : Effect.fail(new PruneNotFinished()),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis") }),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.fail(new PruneNotFinished()),
            }),
          );

        // A reader sees it expired from its deadline, whatever the stored row says: the prune that
        // marks the row is forked at start, and a reader never waits for it. So after a restart too.
        const beforeRestart = yield* passes;
        yield* serverControl("restart");
        expect(yield* findCall(actors.owner, lapsed)).toMatchObject({
          status: "expired",
          approval: { decision: "expired", decidedBy: null },
        });
        // Once the start's prune pass has finished, the stored row is marked expired, decided at
        // its deadline.
        yield* nextPass(beforeRestart);
        expect(
          yield* legacyStorage([
            {
              sql: `select status, decided_at = approval_expires_at as decided_at_deadline
                from hosted_tool_calls where id = $1`,
              params: [lapsed],
            },
          ]),
        ).toEqual([[{ status: "expired", decided_at_deadline: true }]]);
        yield* serverControl("start");
        // A reader sees the stored, marked row as expired too.
        expect(yield* findCall(actors.owner, lapsed)).toMatchObject({
          status: "expired",
          approval: { decision: "expired", decidedBy: null },
        });

        // On day 29 a newer call is made. On day 31 the calls past 30 days are no longer found, even
        // by their reference, though they are still stored: the read leaves them out itself.
        const signIn = () =>
          api
            .request(actors.owner, "POST", "/api/auth/sign-in/email", {
              email: "owner@example.test",
              password,
            })
            .pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))));
        yield* serverControl("clock/advance", 200, { milliseconds: 29 * day });
        yield* signIn();
        const recent = (yield* body(
          Failure,
          yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "explode",
            input: { text: "recent" },
          }),
        )).reference;
        expect(recent).toMatch(reference);
        yield* serverControl("clock/advance", 200, { milliseconds: 2 * day });
        yield* signIn();
        // A reference search ignores the range, so only the retention keeps these out.
        for (const id of [lapsed, old ?? ""])
          expect((yield* readLog(actors.owner, { search: id })).page.total, id).toBe(0);
        expect(yield* findCall(actors.owner, recent ?? "")).toMatchObject({ status: "failed" });
        const stored = () =>
          legacyStorage([
            {
              sql: "select id from hosted_tool_calls where id = any($1::text[]) order by id",
              params: [`{${[lapsed, old ?? "", recent ?? ""].join(",")}}`],
            },
          ]);
        // The passes so far, read while the server and its collector run: reading storage stops
        // them both.
        const beforeStart = yield* passes;
        expect(yield* stored()).toEqual([
          [lapsed, old ?? "", recent ?? ""].sort().map((id) => ({ id })),
        ]);
        // After a restart, however far the prune has got, a reader still finds only the recent call.
        yield* serverControl("start");
        yield* signIn();
        for (const id of [lapsed, old ?? ""])
          expect((yield* readLog(actors.owner, { search: id })).page.total, id).toBe(0);
        expect(yield* findCall(actors.owner, recent ?? "")).toMatchObject({ status: "failed" });
        // Once the start's prune pass has finished, only the calls past 30 days are deleted.
        yield* nextPass(beforeStart);
        expect(yield* stored()).toEqual([[{ id: recent ?? "" }]]);
        yield* serverControl("start");
      }),
    ),
  );

  it.effect(scenarios.toolCallLogApprovedAtDeadline.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { path } = yield* deployLoggedApp();
        const owner = yield* viewer(actors.owner);
        const waitingIds = readLog(actors.owner, {
          tool: "review",
          status: "awaiting-approval",
        }).pipe(Effect.map(({ page }) => page.items.map((item) => item.id)));
        const run = (text: string) =>
          Effect.gen(function* () {
            const before = yield* waitingIds;
            const pending = yield* body(
              Pending,
              yield* api.request(actors.owner, "POST", `${path}/tools/run`, {
                tool: "review",
                kind: "mutation",
                input: { text },
              }),
            );
            const id = (yield* waitingIds).find((each) => !before.includes(each)) ?? "";
            expect(id).toMatch(reference);
            return { requestId: pending.requestId, id };
          });
        const approved = yield* run("approve me");
        const declined = yield* run("decline me");

        // An approval answered just before its deadline can still be running when the prune marks
        // its row expired. The prune's own statement, run on the stopped database before either
        // approval is answered, leaves the rows as that moment does.
        const marked = yield* legacyStorage([
          {
            sql: `update hosted_tool_calls set status = 'expired', decided_at = approval_expires_at
              where status = 'awaiting-approval' and id = any($1::text[]) returning id`,
            params: [`{${approved.id},${declined.id}}`],
          },
        ]);
        expect(marked[0]?.map((row) => row.id).sort()).toEqual([approved.id, declined.id].sort());
        yield* serverControl("start");
        for (const id of [approved.id, declined.id])
          expect(yield* findCall(actors.owner, id)).toMatchObject({ status: "expired" });

        // Each answer is still in time, and replaces the mark with what happened and who answered.
        const answer = (requestId: string, action: "accept" | "decline") =>
          api.request(actors.owner, "POST", `${path}/tools/approvals/${requestId}`, {
            response: action === "accept" ? { action, content: {} } : { action },
          });
        expect((yield* answer(approved.requestId, "accept")).body).toEqual({
          status: "answered",
          result: { status: "completed", value: { reviewed: "approve me" } },
        });
        yield* readLogWhen(actors.owner, { tool: "review", status: "succeeded" }, (page) =>
          page.items.some((item) => item.id === approved.id),
        );
        expect(yield* findCall(actors.owner, approved.id)).toMatchObject({
          status: "succeeded",
          approval: { decision: "approved", decidedBy: { id: owner.id, name: owner.name } },
        });
        expect((yield* answer(declined.requestId, "decline")).body).toEqual({
          status: "answered",
          result: { status: "denied", requestId: declined.requestId },
          reference: declined.id,
        });
        expect(yield* findCall(actors.owner, declined.id)).toMatchObject({
          status: "denied",
          approval: { decision: "denied", decidedBy: { id: owner.id } },
        });
        expect(
          (yield* readLog(actors.owner, { tool: "review", status: "expired" })).page.total,
        ).toBe(0);
      }),
    ),
  );

  it.effect(scenarios.toolCallLogWriteFailure.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient;
        if (!/^[A-Za-z0-9_-]+$/.test(actors.organization.id))
          return yield* Effect.die("Expected an organization ID");
        // The log refuses every row this organization writes; nothing else is affected.
        yield* legacyStorage([
          {
            sql: `CREATE FUNCTION e2e_tool_call_log_fault() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN RAISE EXCEPTION 'Synthetic storage failure for the e2e tool call log'; END $$`,
          },
          {
            sql: `CREATE TRIGGER e2e_tool_call_log_fault BEFORE INSERT ON hosted_tool_calls
              FOR EACH ROW WHEN (NEW.organization_id = '${actors.organization.id}')
              EXECUTE FUNCTION e2e_tool_call_log_fault()`,
          },
        ]);
        yield* serverControl("start");
        const { app, path } = yield* deployLoggedApp();
        const key = yield* apiKey(actors.owner, `Unlogged ${randomUUID().slice(0, 6)}`);
        const agent = yield* api.session();
        const call = (tool: string) =>
          api.request(
            agent,
            "POST",
            `${path}/tools/call`,
            { tool, input: { text: "x" } },
            key.bearer,
          );

        // The calls end as they would with a working log, without a reference that leads nowhere.
        const succeeded = yield* call("echo");
        expect(succeeded.status).toBe(200);
        expect(succeeded.body).toMatchObject({ echoed: "x" });
        const failed = yield* body(Failure, yield* call("explode"));
        expect(failed._tag).toBe("ToolCallFailed");
        expect(failed.reference).toBeUndefined();

        const client = yield* mcp.connect(key.key, "unlogged", {
          organization: actors.organization.id,
        });
        const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
        const program = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            execution: Schema.Struct({
              value: Schema.Struct({
                caught: Schema.Struct({ message: Schema.String, reference: Schema.String }),
              }),
              toolCalls: ToolCalls,
            }),
          }),
        )(
          yield* mcpTool(client, "Run a program while the log is failing", "execute", {
            code: `await ${tool("echo")}({ text: "y" });
try { await ${tool("explode")}({ text: "y" }); return { caught: { message: "none", reference: "none" } }; }
catch (error) { return { caught: { message: error.message, reference: typeof error.reference } }; }`,
          }),
        );
        expect(program.execution.value.caught.message).toContain("The service refused y");
        expect(program.execution.value.caught.reference).toBe("undefined");
        expect(program.execution.toolCalls.map((entry) => entry.reference)).toEqual([
          undefined,
          undefined,
        ]);
        const direct = yield* mcpTool(
          client,
          "Call a failing tool while the log is failing",
          "call",
          {
            calls: { path: tool("explode"), input: { text: "z" } },
          },
        );
        expect(direct).toMatchObject({
          execution: { ok: true, value: { ok: false, error: { kind: expect.any(String) } } },
        });
        expect(JSON.stringify(direct)).not.toContain("callLog");
        expect((yield* readLog(actors.owner, { range: "30d" })).page.total).toBe(0);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.toolCallLogPersonalAccounts.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appAccountsFixture;
        const { actors, app, mailA, aliceId } = fixture;
        // Alice's call runs with her personal account; it succeeded, so it is logged after it ends.
        const called = yield* fixture.call(actors.member);
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        const query = { app: app.id };
        const mine = yield* readLogWhen(actors.member, query, (page) => page.total >= 1);
        expect(mine.page.items).toHaveLength(1);
        expect(mine.page.items[0]).toMatchObject({
          member: { id: aliceId },
          status: "succeeded",
          accounts: [{ id: mailA, name: "Alice mail" }],
        });
        // No account is shared, so the log no longer says whether one was.
        expect(mine.raw).not.toContain('"shared"');
        expect((yield* readLog(actors.member, { ...query, search: "Alice mail" })).page.total).toBe(
          1,
        );

        // To owners and admins it is a personal account, without its ID or name, and searching
        // by its name finds nothing.
        for (const actor of [actors.owner, actors.admin]) {
          const seen = yield* readLog(actor, query);
          expect(seen.page.items).toHaveLength(1);
          expect(seen.page.items[0]?.accounts).toEqual([{ id: null, name: null }]);
          expect(seen.raw).not.toContain("Alice mail");
          expect(seen.raw).not.toContain(mailA);
          const searched = yield* readLog(actor, { ...query, search: "Alice mail" });
          expect(searched.page.total).toBe(0);
          expect((yield* findCall(actor, seen.page.items[0]?.id ?? "")).accounts).toEqual([
            { id: null, name: null },
          ]);
        }
      }),
    ),
  );

  it.effect(scenarios.toolCallLogWithheldApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const { app, path } = yield* deployLoggedApp();
        const key = yield* apiKey(actors.member, `Withheld ${randomUUID().slice(0, 6)}`);
        const agent = yield* api.session();
        const failed = yield* body(
          Failure,
          yield* api.request(
            agent,
            "POST",
            `${path}/tools/call`,
            { tool: "explode", input: { text: "x" } },
            key.bearer,
          ),
        );
        const ref = failed.reference ?? "";
        expect(ref).toMatch(reference);
        expect((yield* findCall(actors.member, ref)).app).toEqual({ id: app.id, name: app.name });
        // While the member may use the app, its name finds their call.
        const named = (actor: Session, search: string) => readLog(actor, { app: app.id, search });
        expect((yield* named(actors.member, app.name)).page.total).toBe(1);

        // The owner makes the app private, so the member can no longer use it.
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "private" },
          })).status,
        ).toBe(200);
        const withheld = yield* readLog(actors.member, { search: ref });
        expect(withheld.page.items[0]?.app).toEqual({ id: app.id, name: null });
        expect(withheld.raw).not.toContain(app.name);
        const memberFilters = yield* readFilters(actors.member);
        expect(memberFilters.raw).not.toContain(app.name);
        expect(memberFilters.raw).toContain(app.id);
        // A search for the name, or part of it, finds nothing, so it cannot confirm a guess at
        // the name; the call is still found by its tool.
        for (const search of [app.name, "Release desk"]) {
          const searched = yield* named(actors.member, search);
          expect(searched.page.total, search).toBe(0);
          expect(searched.page.items, search).toEqual([]);
        }
        expect((yield* named(actors.member, "explode")).page.items.map((item) => item.id)).toEqual([
          ref,
        ]);
        for (const actor of [actors.owner, actors.admin]) {
          expect((yield* findCall(actor, ref)).app).toEqual({ id: app.id, name: app.name });
          expect((yield* named(actor, app.name)).page.total).toBe(1);
        }
      }),
    ),
  );

  it.effect(scenarios.toolCallLogErrorContract.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const session = yield* api.session();
        const document = yield* body(
          Schema.Struct({
            paths: Schema.Record(Schema.String, Schema.Json),
            components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Json) }),
          }),
          yield* session.send("GET", "/openapi.json"),
        );
        const schemas = document.components.schemas;
        // Each error's status on `main` before the log added references; both endpoints declare
        // the same errors.
        const statuses: Record<string, ReadonlyArray<string>> = {
          "400": ["AccountChoiceUnsupported", "RequestInvalid"],
          "401": ["Unauthorized"],
          "403": ["Forbidden", "OrganizationForbidden", "ToolBlocked"],
          "404": ["AccountNotFound", "AppNotFound", "ToolNotFound", "VersionNotFound"],
          "409": [
            "AccountRequired",
            "AppNotDeployed",
            "OAuthReconnectRequired",
            "ToolApprovalRequired",
            "ToolKindMismatch",
          ],
          "422": ["AccountSelectionInvalid", "InputInvalid", "ToolElicitationFailed"],
          "500": ["CredentialsError", "StorageError", "ToolPolicyFailed"],
          "502": [
            "AppEvaluationFailed",
            "AppProviderFailed",
            "OAuthRenewalFailed",
            "ToolCallFailed",
          ],
          "503": ["AuthenticationUnavailable"],
          "504": ["ToolListingTimedOut"],
        };
        const Operation = Schema.Struct({
          post: Schema.Struct({ responses: Schema.Record(Schema.String, Schema.Json) }),
        });
        const referenceSchema = { type: "string", pattern: "^call_[0-9a-hjkmnp-tv-z]{14}$" };
        for (const route of ["call", "run"]) {
          const operation = yield* Schema.decodeUnknownEffect(Operation)(
            document.paths[`/api/organizations/{organization}/apps/{app}/tools/${route}`],
          );
          const declared: Record<string, ReadonlyArray<string>> = {};
          for (const [status, response] of Object.entries(operation.post.responses)) {
            if (Number(status) < 400) continue;
            const names = (JSON.stringify(response).match(/#\/components\/schemas\/\w+/gu) ?? [])
              .map((ref) => ref.split("/").at(-1) ?? "")
              .sort();
            declared[status] = [
              ...new Set(names.map((name) => name.replace(/(WithReference|Encoded)$/u, ""))),
            ].sort();
            for (const name of names.filter((each) => each.endsWith("WithReference"))) {
              // The error's own schema, as every other endpoint declares it, plus `reference`.
              const plain = schemas[name.replace(/WithReference$/u, "Encoded")];
              expect(plain, `${route} ${name}`).toBeDefined();
              expect(schemas[name], `${route} ${name}`).toEqual({
                ...(plain as object),
                properties: {
                  ...(plain as { properties: object }).properties,
                  reference: referenceSchema,
                },
              });
            }
          }
          expect(declared, route).toEqual(statuses);
        }

        // Errors as the endpoints return them: the declared status and body, and the reference.
        const { app, path } = yield* deployLoggedApp();
        const key = yield* apiKey(actors.owner, `Errors ${randomUUID().slice(0, 6)}`);
        const agent = yield* api.session();
        const failures: ReadonlyArray<
          readonly [string, string, object, number, string, Record<string, string>?]
        > = [
          ["call", path, { tool: "missing", input: {} }, 404, "ToolNotFound"],
          ["call", path, { tool: "explode", input: { text: "x" } }, 502, "ToolCallFailed"],
          ["call", path, { tool: "explode", input: {} }, 422, "InputInvalid"],
          ["call", path, { tool: "review", input: { text: "x" } }, 409, "ToolApprovalRequired"],
          [
            "call",
            path,
            { tool: "explode", kind: "mutation", input: { text: "x" } },
            409,
            "ToolKindMismatch",
          ],
          // An app the organization does not have is refused as one the caller may not use.
          [
            "call",
            path.replace(app.id, "app_missing"),
            { tool: "echo", input: { text: "x" } },
            403,
            "OrganizationForbidden",
          ],
          ["run", path, { tool: "explode", input: { text: "x" } }, 403, "Forbidden", key.bearer],
        ];
        for (const [route, target, payload, status, tag, headers] of failures) {
          const response = yield* api.request(
            agent,
            "POST",
            `${target}/tools/${route}`,
            payload,
            headers ?? key.bearer,
          );
          expect(response.status, `${route} ${tag}: ${JSON.stringify(response.body)}`).toBe(status);
          const failure = yield* body(Failure, response);
          expect(failure._tag).toBe(tag);
          const properties = Object.keys(
            (schemas[`${tag}WithReference`] as { properties: object }).properties,
          );
          for (const field of Object.keys(response.body as object))
            expect(properties, `${route} ${tag} ${field}`).toContain(field);
        }
      }),
    ),
  );

  it.effect(scenarios.toolCallLogSlowWrite.title, (context) =>
    withHostedCase(
      context,
      slowWrite(false, (statements) =>
        legacyStorage(statements).pipe(Effect.andThen(serverControl("start"))),
      ),
    ),
  );

  it.effect(scenarios.toolCallLogSlowWriteCloud.title, (context) =>
    withHostedCase(
      context,
      slowWrite(true, (statements) =>
        writeRows("sso-database.json", statements).pipe(
          Effect.andThen(
            Effect.addFinalizer(() =>
              writeRows("sso-database.json", [
                { sql: "DROP TRIGGER e2e_tool_call_log_slow ON hosted_tool_calls" },
                { sql: "DROP FUNCTION e2e_tool_call_log_slow()" },
              ]).pipe(Effect.orDie),
            ),
          ),
        ),
      ),
    ),
  );
});
