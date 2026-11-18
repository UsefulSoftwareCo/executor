/**
 * The host's stall check against real work: a released image that builds large apps and installs
 * packages, with restart turned on at the default limit, logs no stall and is not restarted, and
 * every stretch of that work in which its thread is busy without answering ends with an answer.
 * See docker-release-stall.spec.ts for the check itself; the busy rule's counting is covered by
 * the host's Go tests.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schedule, Schema } from "effect";
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

it.live(
  "released image ends every busy, silent stretch of large builds and package installs with an answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The check logs every tick the thread is busy without answering, and when it answers
        // again how long that lasted, so this scenario reads each such stretch from the log:
        // every one must end with an answer. It asserts no bound on a stretch's length. The
        // length depends on the machine and what else runs on it (3 ticks on an otherwise idle
        // 16-CPU machine, 8 on a loaded 4-CPU one), and no bound holds on every machine; the
        // scenario above checks this work against the shipped default limit.
        const server = yield* releasedServerWith({
          environment: { EXECUTOR_HOST_STALL_SECONDS: "1" },
        });
        yield* awaitLogLine(server, armedLine, 30);
        const pid = yield* workerdPid(server);
        yield* healthyWork(server);
        const settled = yield* Effect.all({
          stalls: logLines(server, stalledLine),
          answers: logLines(server, answeredLine),
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (lines) => lines.stalls.length === lines.answers.length,
            times: 30,
          }),
        );
        expect(settled.answers.length, "every busy, silent stretch ended with an answer").toBe(
          settled.stalls.length,
        );
        expect(
          settled.stalls.length,
          "the work kept the thread busy without answering",
        ).toBeGreaterThan(0);
        expect(yield* containerState(server)).toEqual({ running: true, restarts: 0 });
        expect(yield* workerdPid(server)).toBe(pid);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);
