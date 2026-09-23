/** Own one real Cloudflare environment for a suite, including cleanup on failure or interruption. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import { createEmulatorFixture, emulatorRequest } from "./support/emulators.ts";

class DeployedTestFailed extends Schema.TaggedError<DeployedTestFailed>()("DeployedTestFailed", {
  message: Schema.String,
}) {}
const command = Command.make("e2e-deployed", {
  database: Flag.Literals("database", ["neon", "planetscale"]).pipe(Flag.withDefault("neon")),
  name: Flag.String("test-name").pipe(Flag.withDefault("^(?!.*Claude Code connects)")),
}).pipe(
  Command.withHandler(({ database, name }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const started = yield* Clock.currentTimeMillis;
        const slug = `e2e-ci-${started.toString(36)}-${randomBytes(4).toString("hex")}`;
        const origin = `https://${slug}.executor.engineering`;
        const directory = path.resolve(".local/deployed", slug);
        const cloud = path.resolve("apps/hosted/cloud");
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(
          path.join(directory, "environment.json"),
          JSON.stringify(
            { slug, origin, database, startedAt: new Date(started).toISOString() },
            null,
            2,
          ),
        );
        yield* Console.log(`Testing ${origin} with ${database}. Evidence: ${directory}`);
        const run = (
          phase: string,
          args: readonly string[],
          env: Record<string, string>,
          cwd: string,
          inherit = true,
        ) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const code = Number(
              yield* spawner.exitCode(
                ChildProcess.make("bun", args, {
                  cwd,
                  env: {
                    PATH: process.env.PATH ?? "",
                    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
                    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
                    ...env,
                  },
                  extendEnv: inherit,
                  stdout: "inherit",
                  stderr: "inherit",
                }),
              ),
            );
            yield* Console.log(
              `${phase}: ${Math.round(((yield* Clock.currentTimeMillis) - at) / 1000)}s (exit ${code})`,
            );
            if (code !== 0)
              return yield* new DeployedTestFailed({
                message: `${phase} failed with exit ${code}.`,
              });
          });
        // Register disposal before any deploy attempt. A failed build or provider call can leave resources.
        yield* Effect.addFinalizer(() =>
          run(
            "Environment cleanup",
            ["run", "test-stage", "destroy", slug, "--no-input", "--yes"],
            { CI: "true" },
            cloud,
          ).pipe(Effect.timeout("12 minutes"), Effect.orDie),
        );
        const fixture = yield* createEmulatorFixture(origin);
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            Object.values(Redacted.value(fixture).services),
            (service) =>
              emulatorRequest(service.baseUrl, "/_emulate/reset", {}).pipe(
                Effect.catch(() => Console.error("Could not reset one external test emulator.")),
              ),
            { concurrency: 5, discard: true },
          ),
        );
        const actors = path.join(directory, "actors.json"),
          emulators = path.join(directory, "emulators.json");
        yield* fs.writeFileString(emulators, JSON.stringify(Redacted.value(fixture)), {
          mode: 0o600,
        });
        yield* Effect.addFinalizer(() =>
          Effect.forEach([actors, emulators], (file) => fs.remove(file, { force: true }), {
            discard: true,
          }).pipe(Effect.orDie),
        );
        yield* run(
          "Environment deployment",
          [
            "run",
            "test-stage",
            "deploy",
            slug,
            "--database",
            database,
            "--retention",
            "temporary",
            "--background",
            "active",
            "--owner",
            "Automated test run",
            "--no-input",
            "--yes",
          ],
          {
            CI: "true",
            EXECUTOR_EMULATORS: JSON.stringify(Redacted.value(fixture).services),
            TEST_STAGE_ACCOUNTS_OUTPUT: actors,
            EXECUTOR_APP_UI_BASE_URL: `https://${slug}.executor.website`,
          },
          cloud,
        );
        const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        yield* http
          .get(`${origin}/health`)
          .pipe(Effect.retry(Schedule.spaced("2 seconds")), Effect.timeout("2 minutes"));
        const axiomToken = yield* Config.Redacted("AXIOM_TOKEN");
        const axiomOrganization = yield* Config.NonEmptyString("AXIOM_ORG_ID");
        const axiom = http.pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.bearerToken(axiomToken),
              HttpClientRequest.setHeader("x-axiom-org-id", axiomOrganization),
            ),
          ),
        );
        const traceReader = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const request = yield* HttpClientRequest.post("https://api.axiom.co/v2/tokens").pipe(
              HttpClientRequest.bodyJson({
                name: slug,
                expiresAt: new Date(started + 3 * 60 * 60 * 1000).toISOString(),
                datasetCapabilities: { "executor-next-test-traces": { query: ["read"] } },
              }),
            );
            const response = yield* axiom.execute(request);
            return yield* response.json.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    id: Schema.NonEmptyString,
                    token: Schema.RedactedFromValue(Schema.NonEmptyString),
                  }),
                ),
              ),
            );
          }).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(
              () => new DeployedTestFailed({ message: "Could not create the test trace reader." }),
            ),
          ),
          (reader) =>
            axiom.del(`https://api.axiom.co/v2/tokens/${encodeURIComponent(reader.id)}`).pipe(
              Effect.asVoid,
              Effect.timeout("30 seconds"),
              Effect.mapError(
                () =>
                  new DeployedTestFailed({ message: "Could not revoke the test trace reader." }),
              ),
              Effect.orDie,
            ),
        );
        yield* run(
          "Deployed tests",
          ["run", "e2e:cloud", "--test-name", name],
          {
            CI: "true",
            E2E_CLOUD_URL: origin,
            E2E_CLOUD_ACTORS: actors,
            E2E_EMULATORS: emulators,
            E2E_AXIOM_TOKEN: Redacted.value(traceReader.token),
            E2E_AXIOM_ORG_ID: axiomOrganization,
            E2E_AXIOM_DATASET: "executor-next-test-traces",
          },
          path.resolve("."),
          false,
        );
      }),
    ),
  ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
