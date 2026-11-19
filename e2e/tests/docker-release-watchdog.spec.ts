/**
 * One app isolate in a synchronous loop holds the image's only workerd JavaScript thread, so the
 * product and every other app stop answering, and no timeout inside workerd can fire. OSS workerd
 * enforces no CPU limit, so the host's watchdog bounds the outage: after a run of failed health
 * probes, it sends SIGTERM and kills workerd five seconds later if it is still running. The host
 * exits, and the container's restart policy starts a fresh process in which the other apps answer
 * again.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schedule, Schema } from "effect";
import { appsManifest } from "../support/apps-release.ts";
import { releasedServerWith } from "../support/docker-release-server.ts";

const spinner = `import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({
  spin: query({ input: object({}) }, async () => { for (;;) {} }),
}) });`;
const steady = `import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({
  ping: query({ input: object({}) }, async () => "pong"),
}) });`;

it.live("released image restarts after an app isolate spins, and other apps answer again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* releasedServerWith({
        environment: {
          EXECUTOR_WATCHDOG_INTERVAL: "1",
          EXECUTOR_WATCHDOG_FAILURES: "3",
          // The whole-host watchdog: with app code in the product's process, as before isolation.
          EXECUTOR_APP_PROCESS: "shared",
        },
        restart: "unless-stopped",
      });
      const spinning = yield* server.deploy("Spinner", [
        { path: "index.ts", content: spinner },
        appsManifest,
      ]);
      const other = yield* server.deploy("Steady", [
        { path: "index.ts", content: steady },
        appsManifest,
      ]);
      const ping = server.json(
        Schema.Literal("pong"),
        `${server.prefix}/apps/${other.id}/tools/call`,
        {
          tool: "ping",
          kind: "query",
          input: {},
        },
      );
      const healthy = server.request("/health").pipe(
        Effect.timeout("2 seconds"),
        Effect.map((response) => response.status === 200),
        Effect.orElseSucceed(() => false),
      );
      expect(yield* ping).toBe("pong");
      expect(yield* server.restartCount).toBe(0);

      // The spinning call never returns; it ends when its process does.
      yield* Effect.forkScoped(
        Effect.ignore(
          server.request(`${server.prefix}/apps/${spinning.id}/tools/call`, {
            tool: "spin",
            kind: "query",
            input: {},
          }),
        ),
      );
      // While it spins, the product and every other app stop answering.
      yield* healthy.pipe(
        Effect.filterOrFail(
          (ok) => !ok,
          () => "The product still answers",
        ),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
      );
      const stalled = Date.now();

      // The watchdog restarts the container, and the other app answers again within a minute.
      yield* server.restartCount.pipe(
        Effect.filterOrFail(
          (count) => count >= 1,
          () => "Docker has not restarted the container",
        ),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
      );
      yield* healthy.pipe(
        Effect.filterOrFail(
          (ok) => ok,
          () => "The restarted product is not ready",
        ),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
      );
      expect(yield* ping).toBe("pong");
      expect(Date.now() - stalled).toBeLessThan(60_000);
      expect(yield* server.logs).toContain(
        "Executor watchdog: the product did not answer 3 health checks in a row",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
