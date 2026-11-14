/**
 * An app that declares `sharedRuntime` runs every caller's calls in one warm runtime: its app
 * Worker and, with a database, its data facet are named by build alone. Each call still carries its
 * own accounts, caller, approver and per-caller cache, so concurrent calls from different people
 * never see each other's. Only module scope is shared, which the fixture shows by remembering the
 * last marker it saw. An app that does not declare it keeps a runtime for each account selection.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { McpClient } from "../support/mcp-client.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Telemetry } from "../support/evidence.ts";
import { appsManifest, firstMigration } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";

/**
 * Each call reports the isolate that ran it, the last marker that isolate's module saw, and what
 * the call itself received. `record` also writes its marker to the app's database.
 */
const source = (options: {
  readonly name: string;
  readonly shared: boolean;
  readonly sql: boolean;
}) =>
  `import { defineApp, defineProvider, secrets, object, plain, string, query, mutation, router } from "apps";
import { always } from "apps/operations/approval";
const service = defineProvider({ name: ${JSON.stringify(options.name)}, auth: {
  key: secrets({ label: "Key", fields: object({ marker: plain(string()), token: string() }) })
} });
let isolate;
let last = null;
const observe = async (ctx) => {
  isolate ??= crypto.randomUUID();
  const previous = last;
  last = ctx.user.accounts.service.fields.marker;
  // Let other callers' calls run in this isolate before this one reads its context again.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const account = ctx.user.accounts.service;
  return {
    isolate,
    previous,
    account: account.id,
    marker: account.fields.marker,
    token: account.fields.token,
    subject: ctx.caller?.subject ?? null,
    approvedBy: ctx.approvedBy?.subject ?? null,
    cached: await ctx.cache.forCaller().get({ key: "me", schema: string(), freshFor: "1 hour",
      load: async () => (ctx.caller?.subject ?? "none") + "|" + account.fields.marker }),
  };
};
const input = object({});
const tools = {
  warm: query({ input }, observe),
  probe: query({ input }, observe),
  reviewed: query({ input: object({ note: string() }), approval: always() }, observe),
  ${
    options.sql
      ? `record: mutation({ input }, async (ctx) => {
    ctx.sql.exec("INSERT INTO notes (id) VALUES (?)", ctx.user.accounts.service.fields.marker + ":" + crypto.randomUUID());
    return observe(ctx);
  }),
  notes: query({ input }, async (ctx) => ctx.sql.exec("SELECT id FROM notes").toArray().map((row) => row.id)),`
      : ""
  }
};
export default defineApp({ ${options.shared ? "sharedRuntime: true, " : ""}user: { accounts: { service } } }, { tools: router(tools) });`;

const Observed = Schema.Struct({
  isolate: Schema.String,
  previous: Schema.NullOr(Schema.String),
  account: Schema.String,
  marker: Schema.String,
  token: Schema.String,
  subject: Schema.String,
  approvedBy: Schema.NullOr(Schema.String),
  cached: Schema.String,
});
type Observed = typeof Observed.Type;
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Access = Schema.Struct({ revision: Schema.String });
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
type Tags = Readonly<Record<string, string>>;
/** What started for a call that names the runtime: the app Worker, the facet or its Worker. */
const startedRuntime = (tags: Tags) =>
  (tags["executor.runtime.started"] ?? "")
    .split(",")
    .filter((part) => part === "app" || part === "facet" || part === "facet-worker");

const fixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    mcp = yield* McpClient,
    telemetry = yield* Telemetry;
  const prefix = `/api/organizations/${actors.organization.id}`;

  /** Deploy the fixture app, open it to everyone and let `users` each link their own account. */
  const deploy = (options: { readonly shared: boolean; readonly sql: boolean }) =>
    Effect.gen(function* () {
      const name = `Shared runtime ${randomUUID().slice(0, 8)}`;
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name,
        files: [
          { path: "index.ts", content: source({ name, ...options }) },
          appsManifest,
          ...(options.sql ? [firstMigration] : []),
        ],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(App, deployed),
        path = `${prefix}/apps/${app.id}`;
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", path).pipe(Effect.ignore),
      );
      const access = yield* body(Access, yield* api.request(actors.owner, "GET", `${path}/access`));
      expect(
        (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
          revision: access.revision,
          audience: { kind: "everyone" },
        })).status,
      ).toBe(200);
      return { app, path, name };
    });

  /** Connect `actor`'s own account from the app, which links it for them. */
  const link = (actor: Session, path: string, label: string) =>
    Effect.gen(function* () {
      const marker = `${label}-${randomUUID()}`,
        token = `token-${marker}`;
      const pending = yield* api.request(
        actor,
        "POST",
        connectionsPath(path, "user", "service"),
        {},
      );
      expect(pending.status, JSON.stringify(pending.body)).toBe(200);
      const saved = yield* api.request(
        actor,
        "POST",
        `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
        { method: "key", label: `Shared runtime ${label}`, fields: { marker, token } },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const account = (yield* body(Resource, saved)).id;
      yield* Effect.addFinalizer(() =>
        api.request(actor, "DELETE", `${prefix}/accounts/${account}`).pipe(Effect.ignore),
      );
      return { marker, token, account };
    });

  /** One person: their MCP agent over a personal access token, and their dashboard session. */
  const person = (actor: Session, label: string, app: typeof App.Type, path: string) =>
    Effect.gen(function* () {
      const issued = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
        name: `Shared runtime ${label}`,
      });
      expect(issued.status).toBe(200);
      const key = yield* body(Token, issued);
      yield* Effect.addFinalizer(() =>
        api
          .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
          .pipe(Effect.ignore),
      );
      const client = yield* mcp.connect(key.key, `shared-runtime-${label}`, {
        organization: actors.organization.id,
      });
      const linked = yield* link(actor, path, label);
      const completed = (result: unknown) =>
        Schema.decodeUnknownEffect(Schema.Struct({ structuredContent: Completed }))(result).pipe(
          Effect.flatMap((done) =>
            Schema.decodeUnknownEffect(Observed)(done.structuredContent.execution.value),
          ),
        );
      const execute = (step: string, tool: string, input: Schema.Json = {}) =>
        client.use(step, (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].${tool}(${JSON.stringify(input)});`,
              },
            },
            undefined,
            { signal },
          ),
        );
      /** A call through the person's agent. */
      const agent = (step: string, tool: string) =>
        execute(step, tool).pipe(Effect.flatMap(completed));
      /** An approval-gated call the person's own agent approves. */
      const approved = (step: string) =>
        Effect.gen(function* () {
          const paused = yield* Schema.decodeUnknownEffect(Pending)(
            (yield* execute(`${step} asks`, "reviewed", { note: step })).structuredContent,
          );
          return yield* completed(
            yield* client.use(`${step} approves`, (client, signal) =>
              client.callTool(
                {
                  name: "resume",
                  arguments: { requestId: paused.requestId, response: { action: "accept" } },
                },
                undefined,
                { signal },
              ),
            ),
          );
        });
      /** A call from the person's dashboard session. */
      const dashboard = (tool: string) =>
        api.request(actor, "POST", `${path}/tools/call`, { tool, input: {} }).pipe(
          Effect.tap((response) =>
            Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
          ),
          Effect.flatMap((response) => body(Observed, response)),
        );
      return { label, ...linked, agent, approved, dashboard };
    });
  type Person = Effect.Success<ReturnType<typeof person>>;

  /** Every result carries its own caller's account, subject, approver and cached value. */
  const expectOwn = (
    results: ReadonlyArray<{
      readonly who: Person;
      readonly result: Observed;
      readonly approved: boolean;
    }>,
  ) => {
    const subjects = new Map<string, string>();
    for (const { who, result, approved } of results) {
      expect(result.marker, `${who.label}'s account`).toBe(who.marker);
      expect(result.token, `${who.label}'s credential`).toBe(who.token);
      expect(result.account).toBe(who.account);
      const subject = subjects.get(who.label) ?? result.subject;
      subjects.set(who.label, subject);
      expect(result.subject, `${who.label}'s caller`).toBe(subject);
      expect(result.approvedBy, `${who.label}'s approver`).toBe(approved ? subject : null);
      expect(result.cached, `${who.label}'s cache`).toBe(`${subject}|${who.marker}`);
    }
    // Each person is a distinct caller.
    expect(new Set(subjects.values()).size).toBe(subjects.size);
  };

  /** The tags of `app`'s MCP tool calls of `tool`, once `count` of them say what started. */
  const toolCalls = (app: typeof App.Type, tool: string, count: number) =>
    telemetry.spans("mcp.tool.call", { app: app.id }).pipe(
      Effect.map((found) =>
        found.filter(
          (tags) =>
            tags["executor.tool.name"] === tool && tags["executor.runtime.started"] !== undefined,
        ),
      ),
      Effect.flatMap((found) =>
        found.length >= count
          ? Effect.succeed(found)
          : Effect.fail(new Error(`${found.length} of ${count} ${tool} calls have arrived`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
    );

  return { actors, deploy, person, expectOwn, toolCalls };
});

/** Calls per person in the concurrent round, alternating between people. */
const perPerson = 12;

layer(HostedLive, { excludeTestServices: true })("Shared runtime", (it) => {
  it.effect(
    scenarios.sharedRuntime.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { actors, deploy, person, expectOwn, toolCalls } = yield* fixture;
          for (const sql of [true, false]) {
            const { app, path } = yield* deploy({ shared: true, sql });
            const alice = yield* person(actors.member, "alice", app, path),
              bob = yield* person(actors.admin, "bob", app, path),
              carol = yield* person(actors.owner, "carol", app, path);
            const people = [alice, bob, carol];

            // One call starts the runtime; every later call, from anyone, finds it warm.
            const warm = yield* alice.agent("alice warms the runtime", "warm");
            yield* toolCalls(app, "warm", 1);

            // Interleaved calls from three people at once: agents and the dashboard, reads,
            // database writes, and an approval each person's own agent answers while the others'
            // calls run.
            const plan = Array.from({ length: perPerson }, (_, round) =>
              people.map((who) => ({
                who,
                step: `${who.label} ${round}`,
                via:
                  round === 3
                    ? ("approval" as const)
                    : who === carol && round % 2 === 0
                      ? ("dashboard" as const)
                      : ("agent" as const),
                tool: sql && round % 3 === 0 && round !== 3 ? "record" : "probe",
              })),
            ).flat();
            const results = yield* Effect.all(
              plan.map(({ who, step, via, tool }) =>
                Effect.gen(function* () {
                  const result =
                    via === "approval"
                      ? yield* who.approved(step)
                      : via === "dashboard"
                        ? yield* who.dashboard(tool)
                        : yield* who.agent(step, tool);
                  return { who, result, approved: via === "approval" };
                }),
              ),
              { concurrency: "unbounded" },
            );
            expectOwn(results);

            // They all ran in the one isolate the first call started, and its module scope is
            // shared: some call found another person's marker there.
            expect(new Set(results.map(({ result }) => result.isolate))).toEqual(
              new Set([warm.isolate]),
            );
            expect(
              results.some(
                ({ who, result }) => result.previous !== null && result.previous !== who.marker,
              ),
            ).toBe(true);

            // No call after the first started an app Worker or a data facet.
            const agentCalls = (tool: string) =>
              plan.filter((call) => call.via === "agent" && call.tool === tool).length;
            const observed = [
              ...(yield* toolCalls(app, "probe", agentCalls("probe"))),
              ...(sql ? yield* toolCalls(app, "record", agentCalls("record")) : []),
              ...(yield* toolCalls(app, "reviewed", people.length)),
            ];
            expect(observed.flatMap(startedRuntime)).toEqual([]);

            if (sql) {
              // Every person's writes committed, each with its own marker.
              const notes = yield* body(
                Schema.Array(Schema.String),
                yield* Effect.flatMap(Api, (api) =>
                  api.request(actors.owner, "POST", `${path}/tools/call`, {
                    tool: "notes",
                    input: {},
                  }),
                ),
              );
              for (const who of people)
                expect(notes.filter((note) => note.startsWith(`${who.marker}:`)).length).toBe(
                  plan.filter(
                    (call) => call.who === who && call.via !== "approval" && call.tool === "record",
                  ).length,
                );
            }
          }
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    scenarios.sharedRuntimeOptOut.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { actors, deploy, person, expectOwn, toolCalls } = yield* fixture;
          for (const sql of [true, false]) {
            const { app, path } = yield* deploy({ shared: false, sql });
            const alice = yield* person(actors.member, "alice", app, path),
              bob = yield* person(actors.admin, "bob", app, path);
            const first = yield* alice.agent("alice warms her runtime", "warm");
            yield* toolCalls(app, "warm", 1);
            const second = yield* alice.agent("alice calls again", "warm");
            expect(second.isolate).toBe(first.isolate);
            // Bob's selection has its own runtime.
            const other = yield* bob.agent("bob calls", "probe");
            expect(other.isolate).not.toBe(first.isolate);
            if (sql) {
              // His database call replaced Alice's facet with one of his own.
              const [call] = yield* toolCalls(app, "probe", 1);
              expect(startedRuntime(call!)).toContain("facet");
            }
            // Concurrent calls still carry their own caller's context, each in its own runtime.
            const results = yield* Effect.all(
              Array.from({ length: 4 }, (_, round) =>
                [alice, bob].map((who) =>
                  who
                    .agent(`${who.label} ${round}`, "probe")
                    .pipe(Effect.map((result) => ({ who, result, approved: false }))),
                ),
              ).flat(),
              { concurrency: "unbounded" },
            );
            expectOwn([
              { who: alice, result: first, approved: false },
              { who: bob, result: other, approved: false },
              ...results,
            ]);
            // A host that unloads a replaced facet starts it again, so only the two people's
            // isolates are compared: none is shared, and no module scope crosses selections.
            const isolates = (who: typeof alice) =>
              new Set(
                results.filter((call) => call.who === who).map(({ result }) => result.isolate),
              );
            const bobs = isolates(bob);
            for (const isolate of [first.isolate, ...isolates(alice)])
              expect(bobs.has(isolate)).toBe(false);
            for (const { who, result } of results)
              expect(result.previous === null || result.previous === who.marker).toBe(true);
          }
        }).pipe(Effect.provide(McpClient.layer)),
      ),
    { timeout: 180_000 },
  );
});
