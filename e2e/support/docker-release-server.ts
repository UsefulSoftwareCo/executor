import { expect } from "@effect/vitest";
import { Config, Console, Effect, Exit, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { driver } from "./platform.ts";
import { containerNpmRegistry } from "./npm-registry.ts";

export interface ReleasedServerOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly docker?: readonly string[];
}

export const releasedServerWith = (options: ReleasedServerOptions = {}) =>
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
    const encryptionKey = randomBytes(32).toString("hex");
    const environment: Record<string, string> = {
      DO_NOT_TRACK: "1",
      PORT: "8080",
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      EXECUTOR_ENCRYPTION_KEY: encryptionKey,
      ...options.environment,
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
          ...(options.docker ?? []),
          image,
        ],
        environment,
      ),
      () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
    );
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit)
        ? processes
            .string(ChildProcess.make("docker", ["logs", id], { stderr: "pipe" }), {
              includeStderr: true,
            })
            .pipe(Effect.flatMap(Console.error), Effect.ignore)
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
    const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
      json(Schema.Struct({ id: Schema.String }), `${prefix}/apps/deploy`, { name, files });
    const exec = (script: string) => run(["exec", "--user", "executor", id, "sh", "-c", script]);
    const execRoot = (script: string) => run(["exec", "--user", "root", id, "sh", "-c", script]);
    const logs = processes.string(ChildProcess.make("docker", ["logs", id], { stderr: "pipe" }), {
      includeStderr: true,
    });
    const restart = run(["restart", id]).pipe(Effect.andThen(ready));
    const restartAfter = (downtime: `${number} seconds`) =>
      run(["stop", id]).pipe(
        Effect.andThen(Effect.sleep(downtime)),
        Effect.andThen(run(["start", id])),
        Effect.andThen(ready),
      );
    return {
      id,
      docker: run,
      ready,
      request,
      json,
      prefix,
      deploy,
      exec,
      execRoot,
      logs,
      restart,
      restartAfter,
      encryptionKey,
      port,
      origin,
      session: cookie,
      organization: organization.id,
    };
  });

export const releasedServer = releasedServerWith();
