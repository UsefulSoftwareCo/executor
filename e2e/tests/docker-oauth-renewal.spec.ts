/**
 * OAuth renewal in the released image: the Go host, workerd and the product actor's storage.
 * A token endpoint that rotates refresh tokens answers slowly while callers wait, loses its
 * caller mid-answer, and then the container is killed mid-renewal and started again at once,
 * as an out-of-memory stop and restart policy do. Every caller settles within an execute
 * deadline, and the grant keeps the service's newest refresh token throughout.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Config, Console, Effect, Exit, Fiber, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { driver } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";
import { containerNpmRegistry } from "../support/npm-registry.ts";

const Read = Schema.Struct({
  service: Schema.Struct({
    refreshed: Schema.Boolean,
    authorization: Schema.NullOr(Schema.String),
  }),
});
/** Concurrent calls, as a test suite and agents make. */
const callers = 4;
/** An agent's execute call gives up after this long; every call must settle within it. */
const executeDeadline = 30_000;
/** Close to the 30-second token request timeout, which bounds a live renewal. */
const slowResponse = 27_000;

it.live(
  "released image keeps a rotating OAuth grant through slow, disconnected and killed renewals",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
        const docker = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(
            ChildProcess.make("docker", args, {
              env,
              extendEnv: true,
              stderr: args[0] === "logs" ? "pipe" : "inherit",
            }),
            { includeStderr: args[0] === "logs" },
          );
        const issuer = yield* oauthSetupIssuer;
        const id = `executor-renewal-${randomBytes(8).toString("hex")}`;
        const registry = yield* containerNpmRegistry;
        // The container shares the runner's network, so it reaches the loopback token endpoint
        // and the runner reaches its listener directly.
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
        const origin = `http://127.0.0.1:${port}`;
        const environment: Record<string, string> = {
          // Release scenarios never send product analytics, even from an image with a baked key.
          DO_NOT_TRACK: "1",
          PORT: String(port),
          HOST: "127.0.0.1",
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
          EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: "true",
        };
        yield* Effect.acquireRelease(docker(["volume", "create", id]), () =>
          docker(["volume", "rm", id]).pipe(Effect.orDie),
        );
        yield* Effect.acquireRelease(
          docker(
            [
              "run",
              "--detach",
              "--name",
              id,
              "--init",
              "--network",
              "host",
              "--volume",
              `${id}:/app/data`,
              ...Object.keys(environment).flatMap((name) => ["--env", name]),
              ...registry.docker,
              image,
            ],
            environment,
          ),
          () => docker(["rm", "--force", id]).pipe(Effect.orDie),
        );
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? docker(["logs", id]).pipe(Effect.flatMap(Console.error), Effect.ignore)
            : Effect.void,
        );
        let cookie = "";
        const request = (route: string, data?: unknown, signal?: AbortSignal) =>
          driver(`image ${route}`, () =>
            fetch(`${origin}${route}`, {
              method: data === undefined ? "GET" : "POST",
              headers: { origin, "content-type": "application/json", cookie },
              ...(data === undefined ? {} : { body: JSON.stringify(data) }),
              ...(signal === undefined ? {} : { signal }),
            }).then((response) =>
              response
                .text()
                .then((text) => ({ status: response.status, headers: response.headers, text })),
            ),
          );
        const json = <S extends Schema.Top>(schema: S, response: { readonly text: string }) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.text);
        const ready = request("/health").pipe(
          Effect.flatMap((response) =>
            response.status === 200 ? Effect.void : Effect.fail("not ready"),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
        );
        yield* ready;

        const setup = yield* request("/api/auth/self-host/setup", {
          name: "Renewal Owner",
          email: "renewal@example.test",
          password: "Synthetic-renewal-password-123!",
          organizationName: "Renewal lab",
        });
        expect(setup.status, setup.text).toBe(200);
        cookie = setup.headers
          .getSetCookie()
          .map((part) => part.split(";")[0])
          .join("; ");
        const [organization] = yield* json(
          Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
          yield* request("/api/auth/organization/list"),
        );
        const prefix = `/api/organizations/${organization.id}`;

        // Tokens issued inside the host's 30-second renewal window renew on every use, and
        // every renewal replaces the refresh token, which the service refuses once replaced.
        yield* issuer.configure({
          refreshTokens: true,
          rotateRefreshTokens: true,
          replacedRefreshTokens: "refused",
          expiresIn: 20,
        });
        const name = `Rotating ${randomUUID().slice(0, 8)}`;
        const deployed = yield* request(`${prefix}/apps/deploy`, {
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ service: await (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json() })),
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, deployed.text).toBe(200);
        const app = yield* json(Schema.Struct({ id: Schema.String }), deployed);
        const appPath = `${prefix}/apps/${app.id}`;
        const profile = yield* json(
          Schema.Struct({ id: Schema.String }),
          yield* request(`${appPath}/profiles`, { accounts: {}, idempotencyKey: randomUUID() }),
        );
        const connection = yield* json(
          Schema.Struct({ id: Schema.String }),
          yield* request(`${appPath}/connections`, {
            requirement: "service",
            profile: profile.id,
          }),
        );
        const started = yield* request(`${prefix}/connections/${connection.id}/oauth/start`, {
          method: "oauth",
          label: "Synthetic rotating account",
        });
        expect(started.status, started.text).toBe(200);
        const { authorizationUrl } = yield* json(
          Schema.Struct({ authorizationUrl: Schema.String }),
          started,
        );
        const consent = yield* driver("consent", () =>
          fetch(authorizationUrl, { redirect: "manual" }),
        );
        expect(consent.status).toBe(302);
        const callbackUrl = consent.headers.get("location");
        expect(callbackUrl).not.toBeNull();
        const completed = yield* request(`${prefix}/connections/${connection.id}/oauth/complete`, {
          callbackUrl,
        });
        expect(completed.status, completed.text).toBe(200);
        // Background profile setup renews the new account; let it finish first.
        yield* request(`${appPath}/profiles/${profile.id}`).pipe(
          Effect.flatMap((response) => json(Schema.Struct({ status: Schema.String }), response)),
          Effect.flatMap((current) =>
            current.status !== "pending" ? Effect.void : Effect.fail("Profile setup is pending"),
          ),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }),
        );

        const call = { profile: profile.id, tool: "read", input: {} };
        const read = (signal?: AbortSignal) => request(`${appPath}/tools/call`, call, signal);
        const renewed =
          (context: string) => (response: { readonly status: number; readonly text: string }) =>
            Effect.gen(function* () {
              expect(response.status, `${context}: ${response.text}`).toBe(200);
              const result = yield* json(Read, response);
              expect(result.service.refreshed, context).toBe(true);
              return result.service.authorization;
            });
        const heldBeyond = (before: number, context: string) =>
          issuer.metrics.pipe(
            Effect.flatMap((current) =>
              current.held > before
                ? Effect.void
                : Effect.fail(new Error(`${context}: no renewal reached the issuer`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 600 }),
          );
        /** Concurrent calls; each must settle within the execute deadline. */
        const concurrentReads = (context: string) =>
          Effect.forEach(
            Array.from({ length: callers }),
            () =>
              Effect.gen(function* () {
                const sent = yield* Clock.currentTimeMillis;
                const response = yield* read(AbortSignal.timeout(executeDeadline)).pipe(
                  Effect.mapError(
                    () => new Error(`${context}: a call did not settle within the deadline`),
                  ),
                );
                const elapsed = (yield* Clock.currentTimeMillis) - sent;
                expect(elapsed, `${context}: ${response.text}`).toBeLessThan(executeDeadline);
                expect(response.text, context).not.toContain("synthetic-refresh-");
                return yield* renewed(context)(response);
              }),
            { concurrency: callers },
          );
        /** The next renewal presents the saved refresh token, which must be the newest. */
        const newestTokenSaved = (context: string) =>
          Effect.gen(function* () {
            const before = yield* issuer.metrics;
            yield* renewed(context)(yield* read());
            expect((yield* issuer.metrics).refreshesIssued, context).toBe(
              before.refreshesIssued + 1,
            );
          });

        yield* renewed("healthy renewal")(yield* read());

        // A live renewal whose token response is slow: callers wait for it, none takes over.
        {
          const context = "slow live renewal";
          yield* issuer.configure({ hold: "refresh-issued" });
          const before = yield* issuer.metrics;
          const holder = yield* Effect.forkChild(read());
          yield* heldBeyond(before.held, context);
          const waiting = yield* Effect.forkChild(
            Effect.forEach(Array.from({ length: callers }), () => read(), {
              concurrency: callers,
            }),
          );
          yield* Effect.sleep(slowResponse);
          expect((yield* issuer.metrics).refreshes - before.refreshes, context).toBe(1);
          yield* issuer.configure({ hold: null });
          yield* issuer.release;
          const tokens = yield* Effect.forEach(
            [yield* Fiber.join(holder), ...(yield* Fiber.join(waiting))],
            renewed(context),
          );
          expect(new Set(tokens).size, context).toBe(1);
          expect((yield* issuer.metrics).refreshesIssued - before.refreshesIssued, context).toBe(1);
          yield* newestTokenSaved(context);
        }

        // The caller that started a renewal disconnects while the service answers it.
        {
          const context = "caller disconnects mid-renewal";
          yield* issuer.configure({ hold: "refresh-issued" });
          const before = yield* issuer.metrics;
          const abort = new AbortController();
          const disconnected = yield* Effect.forkChild(Effect.exit(read(abort.signal)));
          yield* heldBeyond(before.held, context);
          abort.abort();
          expect(Exit.isFailure(yield* Fiber.join(disconnected)), context).toBe(true);
          yield* Effect.sleep("1 second");
          const waiting = yield* Effect.forkChild(concurrentReads(context));
          yield* Effect.sleep("1 second");
          yield* issuer.configure({ hold: null });
          yield* issuer.release;
          const tokens = yield* Fiber.join(waiting);
          expect(new Set(tokens).size, context).toBe(1);
          const settled = yield* issuer.metrics;
          expect(settled.refreshes - before.refreshes, context).toBe(1);
          expect(settled.refreshesIssued - before.refreshesIssued, context).toBe(1);
          yield* newestTokenSaved(context);
        }

        // The container is killed before the service processes a renewal, and started again at
        // once. Callers arriving while the dead renewal's claim is recent recover in time.
        {
          const context = "container killed mid-renewal";
          yield* issuer.configure({ hold: "refresh-unprocessed" });
          const before = yield* issuer.metrics;
          const interrupted = yield* Effect.forkChild(Effect.exit(read()));
          yield* heldBeyond(before.held, context);
          yield* docker(["kill", "--signal", "KILL", id]);
          expect(Exit.isFailure(yield* Fiber.join(interrupted)), context).toBe(true);
          yield* issuer.configure({ hold: null });
          yield* issuer.release;
          yield* docker(["start", id]);
          yield* ready;
          const after = yield* issuer.metrics;
          const tokens = yield* concurrentReads(context);
          expect(new Set(tokens).size, context).toBe(1);
          expect((yield* issuer.metrics).refreshesIssued - after.refreshesIssued, context).toBe(1);
          expect(after.refreshesIssued, context).toBe(before.refreshesIssued);
          yield* newestTokenSaved(context);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
