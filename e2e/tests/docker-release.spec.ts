import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, Schema, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { driver } from "../support/platform.ts";

it.live("released image keeps login and a deployed app across a container restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
      const architecture = yield* Config.String("EXECUTOR_E2E_DOCKER_ARCH");
      const id = `executor-release-${randomBytes(8).toString("hex")}`;
      const run = (args: readonly string[], env: Record<string, string> = {}) =>
        processes.string(ChildProcess.make("docker", args, { env, extendEnv: true }));
      expect(
        (yield* run(["image", "inspect", "--format", "{{.Architecture}}", image])).trim(),
      ).toBe(architecture);
      const port = yield* Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* Effect.acquireRelease(
            Effect.sync(() => createServer()),
            (listener) =>
              driver(
                "release port",
                () => new Promise<void>((resolve) => listener.close(() => resolve())),
              ).pipe(Effect.orDie),
          );
          return yield* driver(
            "allocate port",
            () =>
              new Promise<number>((resolve, reject) => {
                listener.once("error", reject);
                listener.listen(0, "127.0.0.1", () => {
                  const address = listener.address();
                  if (address === null || typeof address === "string")
                    reject(new Error("No test port"));
                  else resolve(address.port);
                });
              }),
          );
        }),
      );
      const origin = `http://127.0.0.1:${port}`;
      const secret = randomBytes(32).toString("hex");
      const key = randomBytes(32).toString("hex");
      yield* Effect.acquireRelease(run(["volume", "create", id]), () =>
        run(["volume", "rm", id]).pipe(Effect.orDie),
      );
      yield* Effect.acquireRelease(
        run(
          [
            "run",
            "--detach",
            "--name",
            id,
            "--init",
            "--publish",
            `127.0.0.1:${port}:4400`,
            "--volume",
            `${id}:/app/data`,
            "--env",
            "BETTER_AUTH_SECRET",
            "--env",
            "EXECUTOR_ENCRYPTION_KEY",
            "--env",
            "BETTER_AUTH_URL",
            image,
          ],
          { BETTER_AUTH_SECRET: secret, EXECUTOR_ENCRYPTION_KEY: key, BETTER_AUTH_URL: origin },
        ),
        () => run(["rm", "--force", id]).pipe(Effect.orDie),
      );
      const request = (route: string, data?: unknown, cookie?: string) =>
        driver("image HTTP request", () =>
          fetch(`${origin}${route}`, {
            method: data === undefined ? "GET" : "POST",
            headers: {
              origin,
              "content-type": "application/json",
              ...(cookie === undefined ? {} : { cookie }),
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          }),
        );
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit)
          ? run([
              "exec",
              id,
              "tail",
              "-n",
              "40",
              "/app/data/diagnostics/executor-selfhost.jsonl",
            ]).pipe(Effect.flatMap(Console.error), Effect.ignore)
          : Effect.void,
      );
      const ready = request("/health").pipe(
        Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail("not ready"))),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 200 }),
      );
      yield* ready;
      const root = yield* request("/");
      expect(root.status).toBe(200);
      expect(yield* driver("dashboard HTML", () => root.text())).toContain("<html");
      const setup = yield* request("/api/auth/self-host/setup", {
        name: "Release Owner",
        email: "release@example.test",
        password: "Synthetic-release-password-123!",
        organizationName: "Release lab",
      });
      expect(setup.status).toBe(200);
      const cookie = setup.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .join("; ");
      const organizations = yield* request("/api/auth/organization/list", undefined, cookie);
      expect(organizations.status).toBe(200);
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
      )(yield* driver("organization response", () => organizations.json()));
      const prefix = `/api/organizations/${parsed[0].id}`;
      const deployed = yield* request(
        `${prefix}/apps/deploy`,
        {
          name: "Image check",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object } from "apps"; import isNumber from "is-number"; export default defineApp({ accounts: {} }, { queries: { check: query({ input: object({}) }, async () => isNumber("2")) } });`,
            },
            {
              path: "package.json",
              content: JSON.stringify({ dependencies: { "is-number": "7.0.0" } }),
            },
          ],
        },
        cookie,
      );
      expect(
        deployed.status,
        yield* driver("deployment result", () => deployed.clone().text()),
      ).toBe(200);
      const app = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        yield* driver("deployment response", () => deployed.json()),
      );
      for (const restart of [false, true]) {
        if (restart) {
          yield* run(["restart", "--time", "15", id]);
          yield* ready;
        }
        const viewer = yield* request("/api/viewer", undefined, cookie);
        expect(viewer.status).toBe(200);
        const called = yield* request(
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "queries.check", input: {} },
          cookie,
        );
        expect(called.status).toBe(200);
        expect(yield* driver("query response", () => called.json())).toBe(true);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
