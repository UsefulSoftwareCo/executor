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

const burnMs = 5000;
const burnRoundCap = 2_000_000_000;
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
        expect((yield* call(0)).x).toBeGreaterThanOrEqual(0);
        expect(yield* containerState(server)).toEqual({ running: true, restarts: 0 });
        expect(yield* workerdPid(server)).toBe(pid);
        expect(yield* workerdStart(server, pid), "workerd's start time").toBe(started);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
