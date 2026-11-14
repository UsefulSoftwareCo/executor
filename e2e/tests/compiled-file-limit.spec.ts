/**
 * A build refuses one of the app's own JavaScript or TypeScript files over 2,000,000 bytes before
 * compiling it: esbuild compiles one file in a single stretch on the thread that runs every app's
 * code. Files of npm packages the app imports are not limited and compile however large. JSON
 * files are outside the limit: the app's own server JSON imports become modules of their own, and
 * other JSON goes through esbuild's JSON loader.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Fiber, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Inventory } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest, withApps } from "../support/apps-release.ts";
import { largeModuleCount, largeModulePackage } from "../support/npm-registry.ts";

const limit = 2_000_000;
/** An app that imports a package whose one module is 3,000,000 bytes, served by the e2e registry. */
const largePackageModule = largeModulePackage.name;
const largePackageApp = [
  {
    path: "index.ts",
    content: `import { defineApp, object, query, router } from "apps";
import { count } from "${largePackageModule}";
export default defineApp({}, {
  tools: router({ count: query({ input: object({}) }, async () => count) }),
});`,
  },
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ [largePackageModule]: largeModulePackage.version }),
    }),
  },
];

const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("VersionBuildFailed"),
  stage: Schema.String,
  location: Schema.optional(Schema.Struct({ file: Schema.String })),
  message: Schema.String,
});

const head = 'export const filler = "';
const tail = '";\n';
/** A module of exactly `bytes` UTF-8 bytes whose `filler` export is `unit` repeated. */
const module = (bytes: number, unit = "x") => {
  const unitBytes = new TextEncoder().encode(unit).length;
  const room = bytes - head.length - tail.length;
  const content = `${head}${unit.repeat(Math.floor(room / unitBytes))}${"x".repeat(room % unitBytes)}${tail}`;
  expect(new TextEncoder().encode(content).length).toBe(bytes);
  return content;
};
/**
 * A module of exactly `bytes` ASCII bytes of generated objects, as an app's bundled API description
 * is: dense code, which costs the compiler far more per byte than one string. `filler` is the
 * number of objects.
 */
const denseModule = (bytes: number) => {
  const entry = (at: number) =>
    `  { id: ${at}, name: "item ${at}", tags: ["a", "b"], nested: { x: ${at}, y: "z" } },\n`;
  const open = "export const filler = [\n";
  const close = "].length;\n";
  const entries: string[] = [];
  let used = open.length + close.length + 3;
  while (used + entry(entries.length).length <= bytes) {
    used += entry(entries.length).length;
    entries.push(entry(entries.length));
  }
  const content = `${open}${entries.join("")}${close}//${" ".repeat(bytes - used)}\n`;
  expect(new TextEncoder().encode(content).length).toBe(bytes);
  return { content, count: entries.length };
};
const dense = denseModule(limit - 1_000);
const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** A module of `filler` followed by a comment that ends the file with `last`. */
const endingWith = (bytes: number, last: string) => {
  const room = bytes - head.length - tail.length - 2 - utf8(last);
  const content = `${head}${"x".repeat(room)}${tail}//${last}`;
  expect(utf8(content)).toBe(bytes);
  return content;
};
const reader = `import { defineApp, object, query, router } from "apps";
import { filler } from "./filler.ts";
export default defineApp({}, {
  tools: router({ size: query({ input: object({}) }, async () => filler.length) }),
});`;

layer(HostedLive, { excludeTestServices: true })("Compiled file limit", (it) => {
  it.effect(scenarios.compiledFileLimit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          api.request(actors.owner, "POST", `${prefix}/apps/deploy`, { name, files });
        const appNames = Effect.gen(function* () {
          const inventory = yield* body(
            Inventory,
            yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
          );
          return inventory.apps.map((app) => app.name);
        });
        const refused = (
          response: { readonly status: number; readonly body: unknown },
          stage: string,
          file: string,
          size: number,
        ) =>
          Effect.gen(function* () {
            expect(response.status, JSON.stringify(response.body)).toBe(422);
            const failed = yield* body(BuildFailed, response);
            expect(failed).toMatchObject({ stage, location: { file } });
            expect(failed.message).toContain(
              `${file} is ${size.toLocaleString("en-US")} bytes; a JavaScript or TypeScript file the build compiles can be at most 2,000,000 bytes (2 MB).`,
            );
            return failed;
          });

        // A module just under the limit builds and runs, beside a larger JSON import, which becomes
        // a module of its own and is outside the limit.
        const underName = `Under the limit ${randomUUID().slice(0, 8)}`;
        const document = `{"items":"${"y".repeat(3_000_000)}"}`;
        const started = yield* Clock.currentTimeMillis;
        const under = yield* deploy(underName, [
          {
            path: "index.ts",
            content: `import { defineApp, object, query, router } from "apps";
import { filler } from "./filler.ts";
import document from "./document.json";
export default defineApp({}, {
  tools: router({
    size: query({ input: object({}) }, async () => ({ filler, document: document.items.length })),
  }),
});`,
          },
          { path: "filler.ts", content: dense.content },
          { path: "document.json", content: document },
          appsManifest,
        ]);
        const finished = yield* Clock.currentTimeMillis;
        yield* evidence.json("under-the-limit.json", {
          status: under.status,
          buildMs: finished - started,
        });
        expect(under.status, JSON.stringify(under.body)).toBe(200);
        const app = yield* body(App, under);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        expect(
          yield* body(
            Schema.Struct({ filler: Schema.Number, document: Schema.Number }),
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
              tool: "size",
              kind: "query",
              input: {},
            }),
          ),
        ).toEqual({ filler: dense.count, document: 3_000_000 });

        // Exactly the limit builds, whatever characters reach it. A high surrogate with no low
        // one after it, here the file's last unit, is three bytes, as TextEncoder writes it.
        const atLimit = {
          ascii: module(limit),
          twoByte: module(limit, "é"),
          threeByte: module(limit, "漢"),
          surrogatePairs: module(limit, "🙂"),
          loneHighAtEnd: endingWith(limit, "\ud800"),
        };
        const accepted: string[] = [];
        for (const [kind, content] of Object.entries(atLimit)) {
          const name = `At the limit ${kind} ${randomUUID().slice(0, 8)}`;
          const deployed = yield* deploy(name, [
            { path: "index.ts", content: reader },
            { path: "filler.ts", content },
            appsManifest,
          ]);
          expect(deployed.status, `${kind}: ${JSON.stringify(deployed.body)}`).toBe(200);
          const atLimitApp = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/apps/${atLimitApp.id}`)
              .pipe(Effect.orDie),
          );
          accepted.push(name);
        }

        // Over the limit is refused before it compiles, and no app is created: one byte over in
        // ASCII and in two-byte characters, and text that is not valid UTF-16, which TextEncoder
        // and esbuild write with three bytes for each lone surrogate. 350,000 unpaired high
        // surrogates, each before a three-byte character, are 700,025 units and 2,100,025 bytes.
        const overLimit = {
          ascii: module(limit + 1),
          twoByte: module(limit + 1, "é"),
          unpairedHigh: `${head}${"\ud800漢".repeat(350_000)}";`,
          loneLow: endingWith(limit + 1, "\udc00"),
          loneHighAtEnd: endingWith(limit + 1, "\ud800"),
        };
        expect(utf8(overLimit.unpairedHigh)).toBe(2_100_025);
        expect(overLimit.unpairedHigh.length).toBe(700_025);
        const refusedNames: string[] = [];
        for (const [kind, content] of Object.entries(overLimit)) {
          const name = `Over the limit ${kind} ${randomUUID().slice(0, 8)}`;
          const deployed = yield* deploy(name, [
            { path: "index.ts", content: reader },
            { path: "filler.ts", content },
            appsManifest,
          ]);
          yield* evidence.json(`over-the-limit-${kind}.json`, deployed.body);
          yield* refused(deployed, "source", "filler.ts", utf8(content));
          refusedNames.push(name);
        }

        // A package's file is not limited: an app that imports a 3,000,000-byte module builds and
        // its tool answers.
        const packageName = `Large package ${randomUUID().slice(0, 8)}`;
        const large = yield* deploy(packageName, largePackageApp);
        yield* evidence.json("large-package.json", large.body);
        expect(large.status, JSON.stringify(large.body)).toBe(200);
        const largeApp = yield* body(App, large);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${largeApp.id}`).pipe(Effect.orDie),
        );
        expect(
          yield* body(
            Schema.Number,
            yield* api.request(actors.owner, "POST", `${prefix}/apps/${largeApp.id}/tools/call`, {
              tool: "count",
              kind: "query",
              input: {},
            }),
          ),
        ).toBe(largeModuleCount);

        const names = yield* appNames;
        for (const name of [underName, ...accepted, packageName]) expect(names).toContain(name);
        for (const name of refusedNames) expect(names).not.toContain(name);
      }),
    ),
  );

  it.effect(
    scenarios.compiledFileLimitResponsive.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deploy = (name: string, files: ReadonlyArray<{ path: string; content: string }>) =>
            api.request(actors.owner, "POST", `${prefix}/apps/deploy`, { name, files });
          // A small app, whose deploy also starts the compiler, answers while nothing holds the
          // runtime's thread. Every app's code and every build share that thread.
          const pinger = yield* deploy(`Pinger ${randomUUID().slice(0, 8)}`, [
            {
              path: "index.ts",
              content: `import { defineApp, object, query, router, string } from "apps";
export default defineApp({}, {
  tools: router({ ping: query({ input: object({}), output: string() }, async () => "pong") }),
});`,
            },
            appsManifest,
          ]);
          expect(pinger.status, JSON.stringify(pinger.body)).toBe(200);
          const pingApp = yield* body(App, pinger);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${pingApp.id}`).pipe(Effect.orDie),
          );
          const ping = api
            .request(actors.owner, "POST", `${prefix}/apps/${pingApp.id}/tools/call`, {
              tool: "ping",
              kind: "query",
              input: {},
            })
            .pipe(Effect.timeout("60 seconds"));
          expect((yield* ping).status).toBe(200);

          /**
           * Deploy `files` while calling the ping tool back to back, and return the longest wait
           * between two answers, counted from before the request was sent until its answer came.
           */
          const measured = (
            label: string,
            files: ReadonlyArray<{ path: string; content: string }>,
          ) =>
            Effect.gen(function* () {
              const answers: number[] = [];
              let failed = 0;
              const sampler = yield* ping.pipe(
                Effect.flatMap((response) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.map((at) =>
                      response.status === 200 ? void answers.push(at) : void (failed += 1),
                    ),
                  ),
                ),
                Effect.catch(() => Effect.sync(() => void (failed += 1))),
                Effect.forever,
                Effect.forkChild,
              );
              const sent = yield* Clock.currentTimeMillis;
              const deployed = yield* deploy(`${label} ${randomUUID().slice(0, 8)}`, files).pipe(
                Effect.timeout("120 seconds"),
              );
              const answered = yield* Clock.currentTimeMillis;
              yield* Fiber.interrupt(sampler);
              expect(failed, "pings that failed").toBe(0);
              const during = answers.filter((at) => at > sent && at < answered);
              const times = [sent, ...during, answered];
              const longestGapMs = Math.max(
                ...times.slice(1).map((at, index) => at - times[index]!),
              );
              return { deployed, deployMs: answered - sent, pings: during.length, longestGapMs };
            });

          // One file just under the limit: the work a legitimate build does on its largest file.
          const accepted = yield* measured("Calibration", [
            { path: "index.ts", content: reader },
            { path: "filler.ts", content: denseModule(limit - 1_000).content },
            appsManifest,
          ]);
          expect(accepted.deployed.status, JSON.stringify(accepted.deployed.body)).toBe(200);
          const acceptedApp = yield* body(App, accepted.deployed);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/apps/${acceptedApp.id}`)
              .pipe(Effect.orDie),
          );

          // A dense file of 15,000,000 bytes, within the 16 MiB source limit. Compiling it would
          // hold the thread for several times as long as the calibration did; refusing it does not
          // hold the thread for even as long as that one file's compile.
          const oversized = denseModule(15_000_000).content;
          const refusedDeploy = yield* measured("Refused", [
            { path: "index.ts", content: reader },
            { path: "filler.ts", content: oversized },
            appsManifest,
          ]);
          yield* evidence.json("responsive.json", {
            accepted: {
              deployMs: accepted.deployMs,
              pings: accepted.pings,
              longestGapMs: accepted.longestGapMs,
            },
            refused: {
              status: refusedDeploy.deployed.status,
              deployMs: refusedDeploy.deployMs,
              pings: refusedDeploy.pings,
              longestGapMs: refusedDeploy.longestGapMs,
            },
          });
          expect(refusedDeploy.deployed.status, JSON.stringify(refusedDeploy.deployed.body)).toBe(
            422,
          );
          expect((yield* body(BuildFailed, refusedDeploy.deployed)).message).toContain(
            "filler.ts is 15,000,000 bytes",
          );
          expect(accepted.pings).toBeGreaterThan(0);
          expect(refusedDeploy.longestGapMs).toBeLessThan(accepted.longestGapMs);

          // What a large package file costs, which the limit does not cover: the apps wait while
          // its 3,000,000-byte module compiles. Recorded, not bounded.
          const packaged = yield* measured("Large package", largePackageApp);
          expect(packaged.deployed.status, JSON.stringify(packaged.deployed.body)).toBe(200);
          const packagedApp = yield* body(App, packaged.deployed);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "DELETE", `${prefix}/apps/${packagedApp.id}`)
              .pipe(Effect.orDie),
          );
          yield* evidence.json("large-package-cost.json", {
            moduleBytes: largeModulePackage.bytes,
            deployMs: packaged.deployMs,
            pings: packaged.pings,
            longestGapMs: packaged.longestGapMs,
          });
        }),
      ),
    180_000,
  );
});
