/** Released-image workflow engine fixtures shared by the docker-release workflow specs. */
import { expect } from "@effect/vitest";
import { Config, Console, Effect, Exit, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { driver } from "./platform.ts";
import { appsManifest } from "./apps-release.ts";
import { containerNpmRegistry } from "./npm-registry.ts";

// Each workflow run is its own durable engine in the image's workerd process. An engine that
// stays loaded after its run finishes keeps its database and state resident, so memory grows
// with every run a server has ever executed. Engines therefore unload once idle, and a run that
// is sleeping or waiting to retry resumes from its durable alarm in a newly loaded engine.

/** A fresh released image with an owner and one deployed app; removed when the scope closes. */
export const workflowServer = (source: string) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
    const id = `executor-release-${randomBytes(8).toString("hex")}`;
    const registry = yield* containerNpmRegistry;
    const run = (args: readonly string[], env: Record<string, string> = {}) =>
      processes.string(ChildProcess.make("docker", args, { env, extendEnv: true }));
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
    const origin = `http://localhost:${port}`;
    const environment: Record<string, string> = {
      // Release scenarios never send product analytics, even from an image with a baked key.
      DO_NOT_TRACK: "1",
      PORT: "8080",
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    };
    yield* Effect.acquireRelease(
      run(
        [
          "run",
          "--detach",
          "--name",
          id,
          "--init",
          "--publish",
          `127.0.0.1:${port}:8080`,
          ...Object.keys(environment).flatMap((name) => ["--env", name]),
          ...registry.docker,
          image,
        ],
        environment,
      ),
      () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
    );
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit)
        ? run(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
        : Effect.void,
    );
    let cookie = "";
    const request = (route: string, data?: unknown) =>
      driver(`${data === undefined ? "GET" : "POST"} ${route}`, (signal) =>
        fetch(`http://127.0.0.1:${port}${route}`, {
          method: data === undefined ? "GET" : "POST",
          signal,
          headers: {
            origin,
            "content-type": "application/json",
            ...(cookie === "" ? {} : { cookie }),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        }),
      );
    const json = <S extends Schema.Top>(schema: S, route: string, data?: unknown) =>
      request(route, data).pipe(
        Effect.flatMap((response) =>
          driver(`read ${route}`, () => response.text()).pipe(
            Effect.flatMap((text) =>
              response.status === 200
                ? Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)
                : Effect.fail(new Error(`${route}: HTTP ${response.status} ${text}`)),
            ),
          ),
        ),
      );
    const ready = request("/health").pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? Effect.void : Effect.fail("not ready"),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
    );
    yield* ready;
    const setup = yield* request("/api/auth/self-host/setup", {
      name: "Release Owner",
      email: "release@example.test",
      password: "Synthetic-release-password-123!",
      organizationName: "Release lab",
    });
    expect(setup.status).toBe(200);
    cookie = setup.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ");
    const [organization] = yield* json(
      Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
      "/api/auth/organization/list",
    );
    const prefix = `/api/organizations/${organization.id}`;
    const app = yield* json(Schema.Struct({ id: Schema.String }), `${prefix}/apps/deploy`, {
      name: "Workflow engines",
      files: [{ path: "index.ts", content: source }, appsManifest],
    });
    const runs = `${prefix}/apps/${app.id}/workflow-runs`;
    // A loaded engine maps its database's shared-memory index into the workerd process; the
    // namespace's own metadata database stays mapped. workerd unloads an idle object after it
    // has been inactive and its callers have gone, within about two and a half minutes.
    const loadedEngines = run([
      "exec",
      "--user",
      "executor",
      id,
      "sh",
      "-c",
      'for process in /proc/[0-9]*; do read name < "$process/comm"; [ "$name" = workerd ] && cat "$process/maps"; done',
    ]).pipe(
      Effect.map(
        (maps) =>
          new Set(
            maps
              .split("\n")
              .map((line) => line.split(/\s+/).at(-1) ?? "")
              .filter(
                (file) =>
                  file.includes("/executor-app-workflows/") &&
                  file.endsWith(".sqlite-shm") &&
                  !file.endsWith("/metadata.sqlite-shm"),
              ),
          ).size,
      ),
    );
    // Stops every engine in the process; the product's state and the engines' storage remain.
    const restart = run(["restart", id]).pipe(Effect.andThen(ready));
    // Stops the process for a while before starting it again, so durable deadlines pass while
    // no engine is running.
    const restartAfter = (downtime: `${number} seconds`) =>
      run(["stop", id]).pipe(
        Effect.andThen(Effect.sleep(downtime)),
        Effect.andThen(run(["start", id])),
        Effect.andThen(ready),
      );
    return { json, runs, loadedEngines, restart, restartAfter };
  });

export const WorkflowRun = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
});

export type WorkflowServer = Effect.Success<ReturnType<typeof workflowServer>>;

/** Polls a run until it reaches a final status. */
export const finishedRun = (server: WorkflowServer, run: string) =>
  server.json(WorkflowRun, `${server.runs}/${run}`).pipe(
    Effect.flatMap((current) =>
      ["complete", "errored", "terminated"].includes(current.status)
        ? Effect.succeed(current)
        : Effect.fail(current),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 150 }),
  );

/** Polls until no engine is loaded, and returns how many remain if some never unload. */
export const unloadedEngines = (server: WorkflowServer) =>
  server.loadedEngines.pipe(
    Effect.flatMap((loaded) => (loaded === 0 ? Effect.succeed(loaded) : Effect.fail(loaded))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
    Effect.catch((error) =>
      typeof error === "number" ? Effect.succeed(error) : Effect.fail(error),
    ),
  );

export const Timed = Schema.Struct({ before: Schema.Number, after: Schema.Number });
