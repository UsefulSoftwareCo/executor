/**
 * The released image's host watches workerd once the product first answers, and notices when its
 * main thread stops answering: busy for EXECUTOR_HOST_STALL_SECONDS one-second ticks, or sleeping
 * or stopped for five times as many. By default it only logs; EXECUTOR_HOST_STALL_RESTART=true
 * makes it stop workerd and exit with an error, so the container's restart policy starts it again.
 *
 * These scenarios stop workerd with SIGSTOP as root in the container, which leaves its thread
 * stopped and silent, and use a short setting so no scenario waits minutes.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Effect, Schedule, Schema } from "effect";
import { appsManifest } from "../support/apps-release.ts";
import { releasedServerWith } from "../support/docker-release-server.ts";
import {
  answeredLine,
  armedLine,
  awaitLogLine,
  awaitThreadState,
  containerState,
  logLines,
  pendingSignals,
  signalBit,
  stalledLine,
  workerdPid,
  workerdStart,
} from "../support/docker-stall.ts";

const SIGKILL = 9;
const SIGTERM = 15;

it.live(
  "released image logs a stopped workerd once and leaves it running by default",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_SECONDS: "5" },
        });
        expect(yield* awaitLogLine(server, armedLine, 30)).toBe(
          "Stall check armed: busy rule 5 ticks, idle rule 25 ticks, busy at 0.50 CPU-seconds a tick, action log only",
        );
        const pid = yield* workerdPid(server);
        yield* server.execRoot(`kill -STOP ${pid}`);
        yield* awaitThreadState(server, pid, "T");
        const line = yield* awaitLogLine(server, stalledLine, 60);
        expect(line).toMatch(
          /^Executor stopped responding: its main thread was sleeping or stopped for 25 one-second ticks with no answer \(rule idle, limit 25; \d+ silent ticks: 0 busy, 25 sleeping or stopped; main thread used \d+\.\d\d CPU-seconds; states (S \d+, )?T \d+\); log only, workerd left running/,
        );
        // Ten more ticks: still one line, and workerd was not signalled. A stopped process holds
        // a signal pending, so the pending mask shows one that the state alone would hide.
        yield* Effect.sleep("10 seconds");
        expect(yield* containerState(server)).toEqual({ running: true, restarts: 0 });
        expect(yield* logLines(server, stalledLine)).toHaveLength(1);
        expect(yield* workerdPid(server)).toBe(pid);
        yield* awaitThreadState(server, pid, "T");
        const pending = yield* pendingSignals(server, pid);
        expect(pending & (signalBit(SIGTERM) | signalBit(SIGKILL)), "signals pending").toBe(0n);
        // Once workerd runs again, the same process answers and the host says so.
        yield* server.execRoot(`kill -CONT ${pid}`);
        yield* server.ready;
        expect(yield* workerdPid(server)).toBe(pid);
        expect(yield* awaitLogLine(server, answeredLine, 10)).toMatch(
          /^Executor answered again after \d+ silent ticks \(0 busy, \d+ sleeping or stopped;/,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);

it.live(
  "released image restarts a stopped workerd when restart is turned on, keeping its data",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // on-failure restarts only a non-zero exit, so a restart proves the host's exit status.
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_SECONDS: "5", EXECUTOR_HOST_STALL_RESTART: "true" },
          docker: ["--restart", "on-failure"],
        });
        expect(yield* awaitLogLine(server, armedLine, 30)).toMatch(/action restart$/);
        const App = Schema.Struct({ id: Schema.String, name: Schema.String });
        const kept = yield* server.deploy("Kept across a stall", [
          {
            path: "index.ts",
            content: `import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({ kept: query({ input: object({}) }, async () => "kept") }) });`,
          },
          appsManifest,
        ]);
        const pid = yield* workerdPid(server);
        const started = yield* workerdStart(server, pid);
        const since = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1;
        yield* server.execRoot(`kill -STOP ${pid}`);
        yield* awaitThreadState(server, pid, "T");
        // 25 idle ticks, then SIGTERM, which a stopped process holds, then SIGKILL 5 s later.
        const restarted = yield* containerState(server).pipe(
          Effect.flatMap((state) =>
            state.restarts >= 1 ? Effect.succeed(state) : Effect.fail(state),
          ),
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 60 }),
          Effect.catch((state) => Effect.succeed(state)),
        );
        expect(restarted, "the container restarted once").toMatchObject({ restarts: 1 });
        const until = Math.ceil((yield* Clock.currentTimeMillis) / 1000);
        const exits = yield* server.docker([
          "events",
          "--since",
          String(since),
          "--until",
          String(until),
          "--filter",
          `container=${server.id}`,
          "--filter",
          "event=die",
          "--format",
          "{{.Actor.Attributes.exitCode}}",
        ]);
        expect(exits.trim().split("\n")[0], "the host's exit status").toBe("1");
        yield* server.ready;
        expect(yield* workerdStart(server, yield* workerdPid(server)), "a new workerd").not.toBe(
          started,
        );
        expect(yield* logLines(server, stalledLine)).toEqual([
          expect.stringMatching(
            /\(rule idle, limit 25; .*\); restarting: stopping workerd and exiting so the container restarts$/,
          ),
        ]);
        expect(yield* logLines(server, /^Executor: workerd stopped responding/)).toHaveLength(1);
        // The app deployed before the stall is still there and runs.
        const app = yield* server.json(App, `${server.prefix}/apps/${kept.id}`);
        expect(app.name).toBe("Kept across a stall");
        expect(
          yield* server.json(Schema.String, `${server.prefix}/apps/${kept.id}/tools/call`, {
            tool: "kept",
            input: {},
          }),
        ).toBe("kept");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);

it.live(
  "released image neither logs nor restarts a container paused for a minute",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The idle rule fires after 40 ticks; the container is paused for 60 seconds.
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_SECONDS: "8", EXECUTOR_HOST_STALL_RESTART: "true" },
        });
        yield* awaitLogLine(server, armedLine, 30);
        const pid = yield* workerdPid(server);
        // A smoke check that pausing a container, for longer than either rule's limit, causes no
        // stall line and no restart. That the check counts the ticks it handled, not the time that
        // passed, is proved by TestTheCheckCountsHandledTicksNotElapsedTime in the host's Go tests;
        // this scenario cannot prove it, as it cannot see the host handle a tick. workerd is stopped
        // first and stays stopped across the pause, so no answer is expected around it, and the
        // host usually counts the 8 seconds before the freeze as stopped ticks.
        yield* server.execRoot(`kill -STOP ${pid}`);
        yield* awaitThreadState(server, pid, "T");
        yield* Effect.sleep("8 seconds");
        // The host is frozen with workerd and handles at most one tick when it wakes.
        yield* server.docker(["pause", server.id]);
        yield* Effect.sleep("60 seconds");
        yield* server.docker(["unpause", server.id]);
        yield* Effect.sleep("4 seconds");
        expect(yield* logLines(server, stalledLine)).toEqual([]);
        expect(yield* containerState(server)).toEqual({ running: true, restarts: 0 });
        yield* server.execRoot(`kill -CONT ${pid}`);
        yield* server.ready;
        expect(yield* workerdPid(server)).toBe(pid);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);

it.live(
  "released image's stall check leaves no trace of its own requests",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Docker's own health check is off here: it asks /health through the public port every 30
        // seconds, and each of those requests is traced as any public request is.
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_SECONDS: "60" },
          docker: ["--no-healthcheck"],
        });
        yield* awaitLogLine(server, armedLine, 30);
        // Nothing else asks the instance anything while the check asks every second.
        yield* Effect.sleep("5 seconds");
        const since = yield* Clock.currentTimeMillis;
        yield* Effect.sleep("25 seconds");
        const Traces = Schema.Struct({
          data: Schema.Array(
            Schema.Struct({ rootOperationName: Schema.String, startedAt: Schema.String }),
          ),
        });
        const traces = yield* server
          .exec("executor-host telemetry '/api/traces?limit=500'")
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Traces))));
        const requests = traces.data.filter(
          (trace) =>
            trace.rootOperationName.startsWith("http.server") &&
            Date.parse(trace.startedAt) >= since,
        );
        expect(requests, "request traces while the instance was idle").toEqual([]);
        // The check was running: it still answers itself and logs nothing else.
        expect(yield* logLines(server, stalledLine)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);
