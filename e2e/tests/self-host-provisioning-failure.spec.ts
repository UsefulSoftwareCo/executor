/**
 * A self-host whose npm registry cannot serve the `apps` package keeps failing its default app
 * installation. The provisioning log names the failed step by its tagged cause, and never quotes
 * the registry's credentials, path or the packages it was asked for.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schedule, Schema } from "effect";
import { Api, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startLoggedSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const LogRecord = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.Union([
      Schema.String,
      Schema.Tuple([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
    ]),
  }),
);
/** Log records with one message, and the fields logged beside it, in file order. */
const records = (text: string, message: string) =>
  text.split("\n").flatMap((line) => {
    const at = line.indexOf("{");
    if (at < 0) return [];
    const record = Schema.decodeUnknownOption(LogRecord)(line.slice(at));
    if (Option.isNone(record)) return [];
    const logged = record.value.message;
    return Array.isArray(logged) && logged[0] === message ? [{ line, fields: logged[1] }] : [];
  });

/** An npm registry answering every request with 404, reached through a credentialed URL. */
const refusingRegistry = Effect.gen(function* () {
  const user = `synthetic-user-${randomUUID().slice(0, 8)}`;
  const password = `synthetic-password-${randomUUID().slice(0, 8)}`;
  const token = `synthetic-token-${randomUUID().slice(0, 8)}`;
  const paths: string[] = [];
  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((request, response) => {
        paths.push(request.url ?? "/");
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("The refusing registry has no port");
  return {
    url: `http://${user}:${password}@127.0.0.1:${address.port}/mirror?token=${token}`,
    paths,
    secrets: [user, password, token, "mirror"],
  };
});

layer(TestLive, { excludeTestServices: true })("Self-host provisioning failure", (it) => {
  it.effect(
    scenarios.selfHostProvisioningFailure.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target;
          const registry = yield* refusingRegistry;
          const server = yield* startLoggedSelfHost(target, {
            EXECUTOR_NPM_REGISTRY: registry.url,
          });
          const api = yield* Api.pipe(
            Effect.provide(Layer.fresh(Api.layer)),
            Effect.provide(Layer.fresh(SessionClients.layer)),
            Effect.provideService(Target, {
              ...target,
              metadata: { ...target.metadata, origin: server.origin },
            }),
          );
          const owner = yield* api.session();
          expect(
            (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
              name: "Provisioning Owner",
              email: "provisioning-owner@example.test",
              password: "Synthetic-provisioning-password-123!",
              organizationName: "Provisioning lab",
            })).status,
          ).toBe(200);

          // The default app pins the `apps` package this host ships; its build asks the registry
          // for it, and the refusal fails the team's installation.
          const fs = yield* FileSystem.FileSystem;
          const { step, attempt } = yield* fs.readFileString(server.log).pipe(
            Effect.map((text) => ({
              step: records(text, "Provisioning step failed"),
              attempt: records(text, "Provisioning attempt failed"),
            })),
            Effect.repeat({
              until: (found) => found.step.length > 0 && found.attempt.length > 0,
              schedule: Schedule.spaced("250 millis"),
              times: 240,
            }),
          );
          expect(
            registry.paths.some((path) => decodeURIComponent(path).endsWith("/apps")),
            "the build fetched the apps package from the registry",
          ).toBe(true);

          const [failed] = step;
          const retried = attempt.find((entry) => entry.fields["job"] === failed?.fields["job"]);
          if (failed === undefined || retried === undefined)
            return yield* Effect.die("Provisioning failure lines missing");
          expect(failed.fields["reason"]).toBe("dependency");
          expect(failed.fields["cause"]).toMatchObject({ tag: "VersionBuildFailed" });
          expect(retried.fields["attempts"]).toBeGreaterThanOrEqual(1);
          expect(retried.fields["outcome"]).toBe("requeued");
          expect(retried.fields["cause"]).toMatchObject({ tag: "VersionBuildFailed" });

          // The registry's credentials, path and query stay out of both lines.
          for (const { line } of [...step, ...attempt])
            for (const secret of registry.secrets)
              expect(line, "the failure omits the registry's credentials and path").not.toContain(
                secret,
              );
        }),
      ),
    120_000,
  );
});
