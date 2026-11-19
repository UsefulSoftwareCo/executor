/**
 * The host's stall check against real work: a released image that builds large apps and installs
 * packages, with restart turned on at the default limit, logs no stall and is not restarted; and a
 * tool holding workerd's main thread at a one-tick setting leaves workerd running and serving, with
 * an answer for every stall the host logs. See docker-release-stall.spec.ts for the check itself.
 *
 * Whether a busy stretch counts as a stall is the machine's to decide (the CPU each tick gives the
 * thread against the host's threshold), so no scenario here requires one. The rule itself, which
 * ticks count and when it fires and recovers, is proved by native/stall_test.go. No scenario here
 * proves recovery at a one-tick setting over real large builds and package installs any longer.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Schedule, Schema } from "effect";
import { appsManifest, withApps } from "../support/apps-release.ts";
import { releasedServerWith } from "../support/docker-release-server.ts";
import {
  answeredLine,
  armedLine,
  awaitLogLine,
  containerState,
  logLines,
  stalledLine,
  workerdPid,
  workerdStart,
} from "../support/docker-stall.ts";

/**
 * A module of about `bytes` ASCII bytes of generated objects, just under the 2,000,000-byte limit
 * on one of an app's own files: dense code, which costs the compiler far more per byte than text.
 */
const denseModule = (bytes: number, name: string) => {
  const entry = (at: number) =>
    `  { id: ${at}, name: "${name} ${at}", tags: ["a", "b"], nested: { x: ${at}, y: "z" } },\n`;
  const open = `export const ${name} = [\n`;
  const close = "].length;\n";
  const entries: string[] = [];
  let used = open.length + close.length;
  while (used + entry(entries.length).length <= bytes) {
    used += entry(entries.length).length;
    entries.push(entry(entries.length));
  }
  return `${open}${entries.join("")}${close}`;
};

/** An app of `files` dense modules near the per-file limit. */
const largeApp = (files: number) => [
  ...Array.from({ length: files }, (_, at) => ({
    path: `data${at}.ts`,
    content: denseModule(1_990_000, `data${at}`),
  })),
  {
    path: "index.ts",
    content: `import { defineApp, object, query, router } from "apps";
${Array.from({ length: files }, (_, at) => `import { data${at} } from "./data${at}.ts";`).join("\n")}
export default defineApp({}, {
  tools: router({ count: query({ input: object({}) }, async () => ${Array.from({ length: files }, (_, at) => `data${at}`).join(" + ")}) }),
});`,
  },
  appsManifest,
];

/**
 * An app that bundles a large npm package, installed from the registry when it builds. The package
 * loads when the tool runs, since some, such as TypeScript, cannot load in a Worker.
 */
const packageApp = (dependency: string, version: string, use: string) => [
  {
    path: "index.ts",
    content: `import { defineApp, object, query, router } from "apps";
export default defineApp({}, {
  tools: router({
    use: query({ input: object({}) }, async () => {
      const library = await import("${dependency}");
      return String(${use});
    }),
  }),
});`,
  },
  {
    path: "package.json",
    content: `${JSON.stringify({ dependencies: withApps({ [dependency]: version }) }, null, 2)}\n`,
  },
];

type Server = Effect.Success<ReturnType<typeof releasedServerWith>>;

/**
 * Two builds of four files near the limit, beside three package installs and builds, while a
 * reader keeps asking for the organization's apps. Returns the deployed apps.
 */
const healthyWork = (server: Server) =>
  Effect.gen(function* () {
    const Deployed = Schema.Struct({ id: Schema.String });
    const work = Effect.all(
      [
        server.deploy("Large sources", largeApp(4)),
        server.deploy("Large sources again", largeApp(4)),
        server.deploy(
          "Faker bundle",
          packageApp("@faker-js/faker", "9.9.0", "typeof library.faker"),
        ),
        server.deploy("TypeScript bundle", packageApp("typescript", "5.9.3", "library.version")),
        server.deploy("Date bundle", packageApp("date-fns", "4.1.0", "typeof library.format")),
      ],
      { concurrency: "unbounded" },
    );
    const reads = server
      .json(Schema.Unknown, `${server.prefix}/apps`)
      .pipe(Effect.andThen(Effect.sleep("500 millis")), Effect.forever);
    const deployed = yield* Effect.raceFirst(work, reads);
    expect(deployed).toHaveLength(5);
    for (const app of deployed) expect(Schema.is(Deployed)(app)).toBe(true);
    expect(
      yield* server.json(Schema.Number, `${server.prefix}/apps/${deployed[0].id}/tools/call`, {
        tool: "count",
        input: {},
      }),
    ).toBeGreaterThan(0);
    return deployed;
  });

it.live(
  "released image with restart turned on and the default limit builds large apps and installs packages without a stall line or restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The shipped default limit, with the check set to act. A gate at a lower limit has no
        // margin: this work kept a healthy thread busy and silent for 7 ticks on a 4-CPU machine
        // with nothing else running, and for 8 beside two CPU-bound processes, where a limit of 8
        // restarted it.
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_RESTART: "true" },
        });
        expect(yield* awaitLogLine(server, armedLine, 30)).toMatch(
          /busy rule 60 ticks.*action restart$/,
        );
        const pid = yield* workerdPid(server);
        yield* healthyWork(server);
        expect(yield* logLines(server, stalledLine)).toEqual([]);
        expect(yield* containerState(server)).toEqual({ running: true, restarts: 0 });
        expect(yield* workerdPid(server)).toBe(pid);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);

/**
 * A tool that keeps workerd's main thread busy until its own clock has advanced `ms`: the clock
 * advances inside the loop, so the burn lasts as long on any machine.
 */
const burnMs = 5000;
/**
 * The most rounds the burn may run, so a workerd whose clock stood still inside the loop fails the
 * scenario at once instead of hanging to its budget: four times the fastest machine measured (about
 * 50,000,000 rounds a CPU-second, a Ryzen 9 9950X) for 5 s, twice over.
 */
const burnRoundCap = 2_000_000_000;
/** How long the burn's call may take, well inside the scenario's budget. */
const burnCallLimit = "120 seconds";
const burnApp = [
  {
    path: "index.ts",
    content: `import { defineApp, number, object, query, router } from "apps";
export default defineApp({}, {
  tools: router({
    burn: query({ input: object({ ms: number(), cap: number() }) }, async (_, { ms, cap }) => {
      const start = Date.now();
      let x = 1;
      let rounds = 0;
      while (Date.now() - start < ms && rounds < cap) {
        for (let i = 0; i < 100000; i++) x = (x * 1103515245 + 12345) % 2147483648;
        rounds += 100000;
      }
      return { x, clockMs: Date.now() - start, capped: Date.now() - start < ms };
    }),
  }),
});`,
  },
  appsManifest,
];

it.live(
  "released image keeps workerd running and answering while a tool holds its main thread, and logs an answer for every stall",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_SECONDS: "1" },
        });
        yield* awaitLogLine(server, armedLine, 30);
        const pid = yield* workerdPid(server);
        // A restarted container can give workerd the same PID; its start time tells them apart.
        const started = yield* workerdStart(server, pid);
        const Deployed = Schema.Struct({ id: Schema.String });
        const app = yield* server.deploy("Burn", burnApp);
        expect(Schema.is(Deployed)(app)).toBe(true);
        const { id } = app as typeof Deployed.Type;
        const Burned = Schema.Struct({
          x: Schema.Number,
          clockMs: Schema.Number,
          capped: Schema.Boolean,
        });
        const call = (ms: number) =>
          server.json(Burned, `${server.prefix}/apps/${id}/tools/call`, {
            tool: "burn",
            input: { ms, cap: burnRoundCap },
          });
        const burn = yield* call(burnMs).pipe(
          Effect.timeoutOrElse({
            duration: burnCallLimit,
            orElse: () =>
              Effect.die(
                new Error(
                  `The burn did not return within ${burnCallLimit}: either workerd's clock did not advance inside the loop, or this machine is far slower than the ${burnRoundCap}-round cap assumes.`,
                ),
              ),
          }),
        );
        expect(
          burn.capped,
          `The burn reached its cap of ${burnRoundCap} rounds after ${burn.clockMs} ms on the tool's own clock: workerd's clock did not advance inside the loop, so this scenario's way of holding the main thread no longer works and needs replacing.`,
        ).toBe(false);
        // Every stall the host logged has ended with its answer, once workerd answers again: as
        // many answer lines as stall lines. None is required; whether one happened is the machine's.
        const settled = yield* Effect.all({
          stalls: logLines(server, stalledLine),
          answers: logLines(server, answeredLine),
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (seen) => seen.stalls.length === seen.answers.length,
            times: 30,
          }),
        );
        yield* Console.log(
          `During the burn the host logged ${settled.stalls.length} stall(s) and ${settled.answers.length} answer(s)`,
        );
        expect(settled.answers.length, "an answer line for every stall line").toBe(
          settled.stalls.length,
        );
        // workerd was left running and serves the next call.
        expect((yield* call(0)).x).toBeGreaterThanOrEqual(0);
        expect(yield* containerState(server)).toEqual({ running: true, restarts: 0 });
        expect(yield* workerdPid(server)).toBe(pid);
        expect(yield* workerdStart(server, pid), "workerd's start time").toBe(started);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
