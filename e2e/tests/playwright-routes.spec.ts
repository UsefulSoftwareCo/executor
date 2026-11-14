/**
 * When a page's last route goes away, Playwright 1.63 sends `Fetch.disable`, and Chromium drops a
 * request it has paused but not yet reported: the request is never sent and never fails. The patch
 * keeps the Fetch domain enabled and continues the requests no route handles
 * (patches/playwright-core.md). These cases run real Playwright and Chromium against a small local
 * server, with no product, so they fail on the unpatched build.
 *
 * - A `{ times: 1 }` route that expires on its one answer, while the page sends its next reads on
 *   that answer, as a dashboard does. Unpatched, about 1 round in 100 strands a read.
 * - A route removed with `unroute` while the page is sending reads, as the support helpers do.
 * - The HTTP cache: off while a route is registered and on again once the last one is removed,
 *   as before the patch, so keeping Fetch enabled changes nothing a scenario sees.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const probe = String.raw`
const scenario = process.argv.at(-1);
const { createServer } = await import("node:http");
const { chromium } = await import("playwright");
let cachedHits = 0;
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.setHeader("content-type", "text/html");
    return response.end("<p>routes</p>");
  }
  if (request.url === "/cached") {
    cachedHits++;
    response.setHeader("cache-control", "max-age=600");
  }
  response.setHeader("content-type", "application/json");
  response.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:" + server.address().port + "/");
const fulfill = (route) => route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
/**
 * Up to \`rounds\` runs, each answered by a route that goes away on its answer, while the page sends
 * four reads as soon as the answer arrives, as the dashboard's runner does. A local server answers
 * a read at once, so one still unanswered after 15 s was dropped; the probe stops at the first.
 */
const runs = (rounds, route) =>
  (async () => {
    for (let round = 0; round < rounds; round++) {
      await route();
      const stranded = await page.evaluate((round) => {
        const reads = [0, 1, 2, 3].map((read) => round + "-" + read);
        const answered = new Set();
        return fetch("/run", { method: "POST" }).then(() =>
          Promise.race([
            Promise.all(
              reads.map((read) => fetch("/read?" + read).then(() => answered.add(read))),
            ),
            new Promise((resolve) => setTimeout(resolve, 15000)),
          ]).then(() => reads.filter((read) => !answered.has(read))),
        );
      }, round);
      if (stranded.length > 0) return { rounds: round + 1, stranded };
    }
    return { rounds, stranded: [] };
  })();
let report;
if (scenario === "expiring") {
  report = await runs(3000, () => page.route("**/run", fulfill, { times: 1 }));
} else if (scenario === "unrouted") {
  // The support helpers remove their route themselves once it has done its job.
  const handler = (route) => fulfill(route).then(() => page.unroute("**/run", handler));
  report = await runs(3000, () => page.route("**/run", handler));
} else {
  const cached = () => page.evaluate(() => fetch("/cached").then((response) => response.status));
  const hits = [];
  await cached();
  await cached();
  hits.push(cachedHits);
  await page.route("**/never-requested", (route) => route.fulfill({ body: "unused" }));
  await cached();
  hits.push(cachedHits);
  await page.unrouteAll();
  await cached();
  hits.push(cachedHits);
  report = { hits };
}
await browser.close();
server.close();
console.log(JSON.stringify(report));
process.exit(0);
`;

const Stranded = Schema.fromJsonString(
  Schema.Struct({ rounds: Schema.Number, stranded: Schema.Array(Schema.String) }),
);
const Cache = Schema.fromJsonString(Schema.Struct({ hits: Schema.Array(Schema.Number) }));

/** Runs one probe under Node; Playwright's Node build is the one the suite drives. */
const run = (name: "expiring" | "unrouted" | "cache") =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["--input-type=module", "--eval", probe, name], {
        cwd: path.resolve("."),
      }),
    );
    const result = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.timeoutOption("150 seconds"));
    if (Option.isNone(result))
      return yield* Effect.die(new Error(`The ${name} probe never exited`));
    const [stdout, stderr, exitCode] = result.value;
    expect(exitCode, stderr).toBe(0);
    return stdout.trim().split("\n").at(-1) ?? "";
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Playwright routes", (it) => {
  it.effect("a read the page sends as a { times: 1 } route expires is answered", () =>
    Effect.gen(function* () {
      const report = yield* Schema.decodeUnknownEffect(Stranded)(yield* run("expiring"));
      expect(report.stranded, `stranded reads in ${report.rounds} rounds`).toEqual([]);
    }),
  );

  it.effect("a read the page sends as the last route is removed is answered", () =>
    Effect.gen(function* () {
      const report = yield* Schema.decodeUnknownEffect(Stranded)(yield* run("unrouted"));
      expect(report.stranded, `stranded reads in ${report.rounds} rounds`).toEqual([]);
    }),
  );

  it.effect("the HTTP cache is off only while a route is registered", () =>
    Effect.gen(function* () {
      const report = yield* Schema.decodeUnknownEffect(Cache)(yield* run("cache"));
      // Two reads before any route reach the server once; the read under a route reaches it
      // again; the read after the last route is gone is answered from the cache.
      expect(report.hits).toEqual([1, 2, 2]);
    }),
  );
});
