/**
 * In-app workflow controls answer every app build, refuse invalid calls before the engine, and
 * never present a start whose run is saved as one to repeat.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, SessionClients } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";
import { startDevelopmentServer } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";

// Each tool returns what its control call answered, or the failure it threw. Releases before the
// account scopes declare requirements as \`{ accounts: {} }\`; later ones as \`{}\`.
const source = (
  requirements: string,
) => `import { defineApp, mutation, query, workflow, object, string, router } from "apps";
const record = workflow({ input: object({ label: string() }) }, async (_ctx, input) => input.label);
const settle = async (work) => {
  try { return { ok: await work() }; }
  catch (error: any) {
    return { failed: { tag: error?._tag ?? null, reason: error?.reason ?? null, retryable: error?.retryable ?? null, message: error?.message ?? "" } };
  }
};
const launch = mutation({ input: object({ label: string(), key: string() }) }, (ctx, input) =>
  settle(async () => (await ctx.workflows.start({ workflow: "record", input: { label: input.label }, key: input.key })).id));
const begin = mutation({ input: object({ label: string() }) }, (ctx, input) =>
  settle(async () => (await ctx.workflows.start({ workflow: "record", input: { label: input.label } })).id));
const runs = query({ input: object({}) }, (ctx) =>
  settle(async () => (await ctx.workflows.list({ limit: 50 })).items.map((item) => item.id)));
const peek = query({ input: object({ run: string() }) }, (ctx, input) =>
  settle(async () => (await ctx.workflows.get({ run: input.run })).id));
export default defineApp(${requirements}, { tools: router({ runs, peek, launch, begin }), workflows: { record } });`;

const kinds = { launch: "mutation", begin: "mutation", runs: "query", peek: "query" } as const;
const Failed = Schema.Struct({
  tag: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  retryable: Schema.NullOr(Schema.Boolean),
  message: Schema.String,
});
const Settled = Schema.Union([
  Schema.Struct({ ok: Schema.Json }),
  Schema.Struct({ failed: Failed }),
]);
const Page = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) });

type Send = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: unknown,
) => ReturnType<(typeof Api.Service)["request"]>;
/** Call the app at `path`'s tools, and read its run history through the management API. */
const appClient = (send: Send, path: string) => ({
  call: (tool: keyof typeof kinds, input: Schema.Json) =>
    Effect.gen(function* () {
      const response = yield* send("POST", `${path}/tools/call`, {
        tool,
        kind: kinds[tool],
        input,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(Settled, response);
    }),
  history: Effect.gen(function* () {
    const response = yield* send("GET", `${path}/workflow-runs?limit=50`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (yield* body(Page, response)).items.map((item) => item.id).toSorted();
  }),
});

/** The self-host test host's storage fault; see `apps/hosted/testing/storage-fault-fixture.ts`. */
const storageFault = "/api/devtools/storage-fault";
/** Whether the armed read failed, and the spans it ran inside, innermost first. */
const Faulted = Schema.Struct({
  failed: Schema.Boolean,
  spans: Schema.optional(Schema.Array(Schema.String)),
});
/** A start's read of its run right after the transaction that saves it. */
const readBack = ["workflow.start.read-back", "workflow.start"];
const Users = Schema.Struct({
  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
});
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));

/**
 * Deploy an app on a fresh test host, which mounts the storage fault, and disarm the fault when
 * the scenario ends.
 */
const faultHost = (label: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    // Only the test entry point mounts the storage fault.
    const origin = yield* startDevelopmentServer(target);
    const api = yield* Api.pipe(
      Effect.provide(Layer.fresh(Api.layer)),
      Effect.provide(Layer.fresh(SessionClients.layer)),
      Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
    );
    const owner = yield* api.session(),
      headers = { origin };
    const send: Send = (method, path, payload) =>
      api.request(owner, method, `${origin}${path}`, payload, headers);
    expect((yield* send("POST", "/api/devtools/operator", {})).status).toBe(200);
    const directory = yield* body(Users, yield* send("GET", "/api/auth/admin/list-users"));
    const developer = directory.users.find((user) => user.email === "agent-agent@example.test");
    if (!developer) return yield* Effect.die("Development owner is missing");
    expect(
      (yield* send("POST", "/api/auth/admin/impersonate-user", { userId: developer.id })).status,
    ).toBe(200);
    const organization = (yield* body(
      Organizations,
      yield* send("GET", "/api/auth/organization/list"),
    ))[0];
    if (!organization) return yield* Effect.die("Development organization is missing");
    const prefix = `/api/organizations/${organization.id}`;
    // A failed assertion must not leave the fault armed.
    yield* Effect.addFinalizer(() => send("DELETE", storageFault).pipe(Effect.orDie));

    const deployed = yield* send("POST", `${prefix}/apps/deploy`, {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      files: [{ path: "index.ts", content: source("{}") }, appsManifest],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    const path = `${prefix}/apps/${app.id}`;
    yield* Effect.addFinalizer(() => send("DELETE", path).pipe(Effect.orDie));
    return { send, app, ...appClient(send, path) };
  });

layer(HostedLive, { excludeTestServices: true })("Workflow controls", (it) => {
  it.effect(scenarios.workflowControls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const apps: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const app of apps)
              yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
          }).pipe(Effect.orDie),
        );
        const deploy = (
          label: string,
          requirements: string,
          manifest: { path: string; content: string },
        ) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Workflow controls ${label} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: source(requirements) }, manifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            apps.push(app.id);
            return `${prefix}/apps/${app.id}`;
          });
        const send: Send = (method, path, payload) =>
          api.request(actors.owner, method, path, payload);

        const check = (path: string) =>
          Effect.gen(function* () {
            const { call, history } = appClient(send, path);
            // Start, list and get each answer with the run, and the start made exactly one.
            const key = `controls-${randomUUID()}`;
            const started = yield* call("launch", { label: "first", key });
            expect(started).toEqual({ ok: expect.stringMatching(/^wfr_/) });
            const run = "ok" in started ? String(started.ok) : "";
            expect(yield* call("runs", {})).toEqual({
              ok: [run],
            });
            expect(yield* call("peek", { run })).toEqual({ ok: run });
            // Starting again with the same key and input returns the same run.
            expect(yield* call("launch", { label: "first", key })).toEqual({
              ok: run,
            });
            expect(yield* history).toEqual([run]);

            // A key over the limit is refused as the caller's input, naming the field, and
            // starts nothing.
            const refused = yield* call("launch", { label: "long", key: "k".repeat(140) });
            expect(refused).toEqual({
              failed: {
                tag: "WorkflowFailure",
                reason: "input",
                retryable: false,
                message: expect.stringContaining(
                  "ctx.workflows.start was refused before Executor started or changed any run. key: Expected a value with a length of at most 128",
                ),
              },
            });
            expect(yield* history).toEqual([run]);
          });

        // An app on this checkout's `apps` release.
        yield* check(yield* deploy("current", "{}", appsManifest));
        // An app built on `apps` beta.84, which names a run's version `deployment`.
        yield* check(
          yield* deploy("beta.84", "{ accounts: {} }", {
            path: "package.json",
            content: JSON.stringify({ dependencies: { apps: "0.0.1-beta.84" } }),
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.workflowStartReadBack.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const { send, app, call, history } = yield* faultHost("Workflow read-back");

        /**
         * Start with the start's first read of this app's runs after its save failing, and return
         * the saved run the failure names.
         */
        const startUnread = (tool: "begin" | "launch", input: Schema.Json, file: string) =>
          Effect.gen(function* () {
            const armed = yield* send("POST", storageFault, { binds: app.id, within: readBack });
            expect(armed.status).toBe(200);
            const settled = yield* call(tool, input);
            const faulted = yield* body(Faulted, yield* send("GET", storageFault));
            yield* evidence.json(file, { settled, faulted });
            expect(faulted, "The fault failed the read-back").toEqual({
              failed: true,
              spans: expect.arrayContaining(readBack),
            });
            // The run is saved, so the failure names it and is not offered as a retry.
            expect(settled).toEqual({
              failed: {
                tag: "WorkflowFailure",
                reason: "engine",
                retryable: false,
                message: expect.stringMatching(/^Run wfr_\S+ exists for this start/),
              },
            });
            const message = "failed" in settled ? settled.failed.message : "";
            return { run: message.split(" ")[1] ?? "", message };
          });

        // Without a key, the failure says starting again makes another run; getting the run by
        // its ID, as it advises, finds it and starts nothing.
        const unkeyed = yield* startUnread("begin", { label: "unkeyed" }, "unkeyed-start.json");
        expect(unkeyed.message).toContain("This start had no key");
        expect(yield* history).toEqual([unkeyed.run]);
        expect(yield* call("peek", { run: unkeyed.run })).toEqual({ ok: unkeyed.run });
        expect(yield* history).toEqual([unkeyed.run]);

        // With a key, starting again with the same key and input returns the saved run.
        const key = `read-back-${randomUUID()}`;
        const keyed = yield* startUnread("launch", { label: "keyed", key }, "keyed-start.json");
        expect(keyed.message).toContain(
          "Starting again with the same key and input returns this run.",
        );
        expect(yield* call("launch", { label: "keyed", key })).toEqual({ ok: keyed.run });
        expect(yield* history).toEqual([unkeyed.run, keyed.run].toSorted());
      }),
    ),
  );

  it.effect(scenarios.workflowStartCommit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const { send, call, history } = yield* faultHost("Workflow commit");
        /** Start with the commit of the start's save failing as `commit` says. */
        const startUncommitted = (
          commit: "refused" | "timeout" | "lost",
          tool: "begin" | "launch",
          input: Schema.Json,
        ) =>
          Effect.gen(function* () {
            const armed = yield* send("POST", storageFault, { commit, within: ["workflow.start"] });
            expect(armed.status).toBe(200);
            const settled = yield* call(tool, input);
            const faulted = yield* body(Faulted, yield* send("GET", storageFault));
            yield* evidence.json(`commit-${commit}-${tool}.json`, { settled, faulted });
            expect(faulted, "The fault reached the start's transaction").toEqual({
              failed: true,
              spans: expect.arrayContaining(["storage.transaction", "workflow.start"]),
            });
            return settled;
          });
        const mayExist = (message: string) => ({
          failed: {
            tag: "WorkflowFailure",
            reason: "engine",
            retryable: false,
            message: expect.stringContaining(message),
          },
        });

        // The database refuses the commit. The host cannot tell that apart from a commit that
        // applied, so the run may exist; without a key, the failure says to check the list.
        expect(yield* startUncommitted("refused", "begin", { label: "refused" })).toEqual(
          mayExist(
            "so the run may exist. This start had no key: check ctx.workflows.list before starting again",
          ),
        );
        expect(yield* history).toEqual([]);

        // The commit times out. With a key, starting again with the same key and input is safe,
        // and here makes the one run the refused commit left out.
        const key = `commit-${randomUUID()}`;
        expect(yield* startUncommitted("timeout", "launch", { label: "timeout", key })).toEqual(
          mayExist(
            "so the run may exist. Starting again with the same key and input returns the run if it was saved.",
          ),
        );
        expect(yield* history).toEqual([]);
        const again = yield* call("launch", { label: "timeout", key });
        expect(again).toEqual({ ok: expect.stringMatching(/^wfr_/) });
        const keyed = "ok" in again ? String(again.ok) : "";
        expect(yield* history).toEqual([keyed]);

        // The commit applies and its answer is lost. Reading the run back confirms the start, so
        // it answers with the run and makes no other.
        const lost = yield* startUncommitted("lost", "begin", { label: "lost" });
        expect(lost).toEqual({ ok: expect.stringMatching(/^wfr_/) });
        const run = "ok" in lost ? String(lost.ok) : "";
        expect(yield* history).toEqual([keyed, run].toSorted());
        expect(yield* call("peek", { run })).toEqual({ ok: run });
      }),
    ),
  );
});
