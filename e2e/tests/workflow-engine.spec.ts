import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, FileSystem, Path, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { driver } from "../support/platform.ts";

const stepSeconds = 150;

const user = `import { WorkflowEntrypoint } from "cloudflare:workers";
export class Runs extends WorkflowEntrypoint {
  async run(event, step) {
    await step.sleep("wait", 5000);
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
      await env.RUNS.create({ id, params: {} });
      return Response.json({ id });
    }
    const handle = await env.RUNS.get(id);
    if (url.pathname === "/pause") await handle.pause();
    if (url.pathname === "/resume") await handle.resume();
    return Response.json(await handle.status());
  },
};`;

const Status = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.Json),
});

const engineServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
  const docker = (args: readonly string[]) =>
    processes.string(ChildProcess.make("docker", args), { includeStderr: args[0] === "logs" });
  const shipped = yield* docker([
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    image,
    "/app/workerd.capnp",
  ]);
  const extension = shipped.match(/^ extensions=\[.*\],$/m)?.[0];
  const workflows = shipped.match(/^ {2}\(name="workflows",worker=\([\s\S]*?^ {2}\)\),$/m)?.[0];
  expect(extension, "the image declares the workflow binding extension").toBeDefined();
  expect(workflows, "the image declares the workflows service").toMatch(/className="Engine"/);
  const service = (workflows ?? "")
    .replaceAll("@@RUNTIME@@/", "")
    .replace(
      /\(name="USER_WORKFLOW",service=\([^)]*\)\)/,
      '(name="USER_WORKFLOW",service=(name="main",entrypoint="Runs"))',
    )
    .replace(/localDisk="[^"]*"/, 'localDisk="engine-data"');
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-engine-" });
  yield* fs.makeDirectory(path.join(directory, "engine-test-data"));
  yield* fs.writeFileString(path.join(directory, "engine-test-user.mjs"), user);
  yield* fs.writeFileString(
    path.join(directory, "engine-test.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
${(extension ?? "").replaceAll("@@RUNTIME@@/", "")}
 services=[
  (name="main",worker=(compatibilityDate="2026-09-01",modules=[(name="user.mjs",esModule=embed "engine-test-user.mjs")],
   bindings=[(name="RUNS",wrapped=(moduleName="cloudflare-runtime:workflows-wrapped-binding",innerBindings=[(name="binding",service=(name="workflows",entrypoint="WorkflowBinding"))]))])),
${service}
  (name="engine-data",disk=(path="/app/engine-test-data",writable=true,allowDotfiles=true)),
 ],
 sockets=[(name="http",address="*:8080",http=(),service="main")]
);
`,
  );
  const port = yield* driver(
    "allocate port",
    () =>
      new Promise<number>((resolve, reject) => {
        const listener = createServer();
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          listener.close(() =>
            address === null || typeof address === "string"
              ? reject(new Error("No test port"))
              : resolve(address.port),
          );
        });
      }),
  );
  const id = `executor-workflow-engine-${randomBytes(8).toString("hex")}`;
  yield* Effect.acquireRelease(
    docker([
      "create",
      "--name",
      id,
      "--user",
      "0:0",
      "--publish",
      `127.0.0.1:${port}:8080`,
      "--entrypoint",
      "/app/workerd",
      image,
      "serve",
      "/app/engine-test.capnp",
      "--experimental",
    ]),
    () => docker(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
  );
  yield* Effect.addFinalizer((exit) =>
    Exit.isFailure(exit)
      ? docker(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
      : Effect.void,
  );
  yield* docker(["cp", `${directory}/.`, `${id}:/app`]);
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
  const ready = driver("health", (signal) =>
    fetch(`http://127.0.0.1:${port}/health`, { signal }),
  ).pipe(
    Effect.flatMap((response) => (response.ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
  );
  yield* docker(["start", id]);
  yield* ready;
  const crash = docker(["kill", "--signal", "KILL", id]).pipe(
    Effect.andThen(docker(["start", id])),
    Effect.andThen(ready),
  );
  const starts = (run: string) =>
    docker(["logs", id]).pipe(
      Effect.map(
        (output) => output.split("\n").filter((line) => line.includes(`LONG-STEP ${run}`)).length,
      ),
    );
  return { call, crash, starts };
});

const Output = Schema.Struct({ started: Schema.Number, finished: Schema.Number });

it.live(
  "an evictable workflow engine finishes a long step on runs no caller holds",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* engineServer;
        const created = Date.now();
        yield* server.call("/create?id=woken");
        yield* server.call("/create?id=resumed");
        yield* Effect.sleep("1 second");
        expect((yield* server.call("/pause?id=resumed")).status).toBe("paused");
        yield* server.crash;
        yield* Effect.sleep("8 seconds");
        expect((yield* server.call("/resume?id=resumed")).status).toBe("running");
        yield* Effect.sleep(`${stepSeconds + 25} seconds`);
        for (const run of ["woken", "resumed"]) {
          const state = yield* server.call(`/status?id=${run}`);
          expect(state.status, `${run} finishes when its step ends`).toBe("complete");
          const output = yield* Schema.decodeUnknownEffect(Output)(state.output);
          expect(yield* server.starts(run), `${run} runs its long step once`).toBe(1);
          expect(output.started - created).toBeLessThan(30_000);
          expect(output.finished - output.started).toBeGreaterThanOrEqual(stepSeconds * 1000);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
