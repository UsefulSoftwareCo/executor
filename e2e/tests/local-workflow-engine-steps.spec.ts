/**
 * workerd unloads an evictable engine about 70 s after its last call once no caller holds it,
 * whatever work is in flight. create() holds the engine it starts; a run woken by its alarm
 * after a restart, resumed after a pause, or woken by an event has no such caller. The local
 * product reads running runs every few seconds, which also keeps their engines loaded, so
 * this runs the engine service the local product declares, exactly as declared, alone in the
 * product's workerd with a small user workflow and nothing reading the runs.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path, Schedule, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestLive, withCase } from "../support/case.ts";
import { startLocalProduct, workflowEngines } from "../support/local-workflow-engines.ts";
import { driver } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import { scenarios } from "../test-plan.ts";

const stepSeconds = 150;
const engineService = "workflows:executor-app-workflows";
const wrappedBinding = "cloudflare-runtime:workflows-wrapped-binding";

const user = `import { WorkflowEntrypoint } from "cloudflare:workers";
export class Runs extends WorkflowEntrypoint {
  async run(event, step) {
    if (event.payload.wake === "event") await step.waitForEvent("go", { type: "go", timeout: "10 minutes" });
    else await step.sleep("wait", 5000);
    const started = await step.do("long", async () => {
      console.log("LONG-STEP " + event.instanceId);
      const started = Date.now();
      await scheduler.wait(${stepSeconds * 1000});
      return started;
    });
    return { started, finished: await step.do("after", async () => Date.now()) };
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/create") {
      await env.RUNS.create({ id, params: { wake: url.searchParams.get("wake") } });
      return Response.json({ id });
    }
    const handle = await env.RUNS.get(id);
    if (url.pathname === "/pause") await handle.pause();
    if (url.pathname === "/resume") await handle.resume();
    if (url.pathname === "/event") await handle.sendEvent({ type: "go", payload: {} });
    return Response.json(await handle.status());
  },
};`;

const Module = Schema.Struct({ name: Schema.String, esModule: Schema.optionalKey(Schema.String) });
/** The part of the workerd config Alchemy's local runtime serves that this scenario reads. */
const DumpedConfig = Schema.Struct({
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      worker: Schema.optionalKey(
        Schema.Struct({
          compatibilityDate: Schema.String,
          compatibilityFlags: Schema.optionalKey(Schema.Array(Schema.String)),
          modules: Schema.Array(Module),
          durableObjectNamespaces: Schema.optionalKey(
            Schema.Array(Schema.Record(Schema.String, Schema.Json)),
          ),
          bindings: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
        }),
      ),
    }),
  ),
  extensions: Schema.Array(Schema.Struct({ modules: Schema.Array(Module) })),
});

/** Cap'n Proto text for a JSON config value; field names are the config's own. */
const capnp = (value: Schema.Json): string =>
  typeof value === "string"
    ? JSON.stringify(value)
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "void"
        : Array.isArray(value)
          ? `[${value.map(capnp).join(",")}]`
          : `(${Object.entries(value)
              .map(([name, field]) => `${name}=${capnp(field)}`)
              .join(",")})`;

// /create answers with the run id only; the other routes answer with the run status.
const Status = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.Json),
});
const Output = Schema.Struct({ started: Schema.Number, finished: Schema.Number });

/** The local product's engine service and a user workflow in one restartable workerd. */
const engineServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "local-workflow-engine-" });
  const dump = path.join(directory, "dump");
  // Alchemy's local runtime writes each workerd config it serves when this is set.
  const executable = yield* Effect.scoped(
    Effect.gen(function* () {
      const local = yield* startLocalProduct({ WORKERD_DUMP_CONFIG: dump });
      return (yield* workflowEngines(local.directory)).executable;
    }),
  );
  expect(Option.isSome(executable), "the local product's workerd executable").toBe(true);
  const [dumped] = yield* fs.readDirectory(dump);
  const config = yield* fs
    .readFileString(path.join(dump, dumped ?? "missing"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DumpedConfig))));
  const worker = config.services.find((service) => service.name === engineService)?.worker;
  const extension = config.extensions
    .flatMap((entry) => entry.modules)
    .find((module) => module.name === wrappedBinding);
  if (worker === undefined || extension?.esModule === undefined)
    return yield* Effect.fail(new Error("The local product declares no workflow engine"));
  const namespace = worker.durableObjectNamespaces?.find(
    (declared) => declared.className === "Engine",
  );
  expect(namespace, "the local product declares the Engine namespace").toBeDefined();
  expect(namespace?.preventEviction ?? false, "local workflow engines may leave memory").toBe(
    false,
  );
  const modules: string[] = [];
  for (const [index, module] of worker.modules.entries()) {
    if (module.esModule === undefined)
      return yield* Effect.fail(new Error(`Engine module ${module.name} is not an ES module`));
    yield* fs.writeFileString(path.join(directory, `engine-${index}.mjs`), module.esModule);
    modules.push(`(name=${JSON.stringify(module.name)},esModule=embed "engine-${index}.mjs")`);
  }
  const bindings = (worker.bindings ?? []).map((binding) =>
    binding.name === "USER_WORKFLOW"
      ? { name: "USER_WORKFLOW", service: { name: "main", entrypoint: "Runs" } }
      : binding,
  );
  const port = yield* freePort;
  yield* fs.makeDirectory(path.join(directory, "engine-data"));
  yield* fs.writeFileString(path.join(directory, "extension.mjs"), extension.esModule);
  yield* fs.writeFileString(path.join(directory, "user.mjs"), user);
  const file = path.join(directory, "engine.capnp");
  yield* fs.writeFileString(
    file,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 extensions=[(modules=[(name=${JSON.stringify(wrappedBinding)},internal=true,esModule=embed "extension.mjs")])],
 services=[
  (name="main",worker=(compatibilityDate=${JSON.stringify(worker.compatibilityDate)},modules=[(name="user.mjs",esModule=embed "user.mjs")],
   bindings=[(name="RUNS",wrapped=(moduleName=${JSON.stringify(wrappedBinding)},innerBindings=[(name="binding",service=(name=${JSON.stringify(engineService)},entrypoint="WorkflowBinding"))]))])),
  (name=${JSON.stringify(engineService)},worker=(compatibilityDate=${JSON.stringify(worker.compatibilityDate)},compatibilityFlags=${capnp(worker.compatibilityFlags ?? [])},
   modules=[${modules.join(",")}],
   durableObjectNamespaces=${capnp(worker.durableObjectNamespaces ?? [])},
   durableObjectStorage=(localDisk="engine-data"),
   bindings=${capnp(bindings)})),
  (name="engine-data",disk=(path=${JSON.stringify(path.join(directory, "engine-data"))},writable=true,allowDotfiles=true)),
 ],
 sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="main")]
);
`,
  );
  const log = path.join(directory, "workerd.log");
  let current: { scope: Scope.Closeable; kill: Effect.Effect<void> } | undefined;
  const stop = Effect.suspend(() => {
    const running = current;
    current = undefined;
    return running === undefined ? Effect.void : Scope.close(running.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => stop);
  const call = (route: string) =>
    driver(route, (signal) => fetch(`http://127.0.0.1:${port}${route}`, { signal })).pipe(
      Effect.flatMap((response) =>
        driver(`read ${route}`, () => response.text()).pipe(
          Effect.flatMap((text) =>
            response.ok
              ? Schema.decodeUnknownEffect(Schema.fromJsonString(Status))(text)
              : Effect.fail(new Error(`${route}: HTTP ${response.status} ${text}`)),
          ),
        ),
      ),
    );
  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const child = yield* processes
      .spawn(
        ChildProcess.make(
          Option.getOrElse(executable, () => "workerd"),
          ["serve", file, "--experimental"],
          { cwd: directory },
        ),
      )
      .pipe(Scope.provide(scope));
    // Every start appends to one log, so a step that ran before a crash is still counted.
    yield* child.all.pipe(Stream.run(fs.sink(log, { flag: "a" })), Effect.forkIn(scope));
    current = { scope, kill: child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore) };
    yield* driver("health", (signal) => fetch(`http://127.0.0.1:${port}/health`, { signal })).pipe(
      Effect.flatMap((response) => (response.ok ? Effect.void : Effect.fail("not ready"))),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
    );
  });
  yield* start;
  // Kills workerd as a crash would, then starts it over the same storage.
  const crash = Effect.suspend(() => current?.kill ?? Effect.void).pipe(
    Effect.andThen(stop),
    Effect.andThen(start),
  );
  const starts = (run: string) =>
    fs
      .readFileString(log)
      .pipe(
        Effect.map(
          (output) => output.split("\n").filter((line) => line.includes(`LONG-STEP ${run}`)).length,
        ),
      );
  return { call, crash, starts };
});

layer(TestLive, { excludeTestServices: true })("Local workflow engine steps", (it) => {
  it.effect(
    scenarios.localWorkflowEngineSteps.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const server = yield* engineServer;
          const created = Date.now();
          yield* server.call("/create?id=woken&wake=sleep");
          yield* server.call("/create?id=resumed&wake=sleep");
          yield* server.call("/create?id=evented&wake=event");
          yield* Effect.sleep("1 second");
          expect((yield* server.call("/pause?id=resumed")).status).toBe("paused");
          // Only the durable alarm can end the sleep of a run whose process crashed.
          yield* server.crash;
          yield* Effect.sleep("8 seconds");
          // A resumed run is started by the resume call, and an event by its delivery; both
          // calls return at once.
          expect((yield* server.call("/resume?id=resumed")).status).toBe("running");
          yield* server.call("/event?id=evented");
          // Nothing calls any engine while their long steps run.
          yield* Effect.sleep(`${stepSeconds + 25} seconds`);
          for (const run of ["woken", "resumed", "evented"]) {
            const state = yield* server.call(`/status?id=${run}`);
            expect(state.status, `${run} finishes when its step ends`).toBe("complete");
            const output = yield* Schema.decodeUnknownEffect(Output)(state.output);
            expect(yield* server.starts(run), `${run} runs its long step once`).toBe(1);
            expect(output.started - created).toBeLessThan(30_000);
            expect(output.finished - output.started).toBeGreaterThanOrEqual(stepSeconds * 1000);
          }
        }),
      ),
    420_000,
  );
});
