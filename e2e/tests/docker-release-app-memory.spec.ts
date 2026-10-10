/**
 * An installed app that nobody calls must cost the server almost nothing. Deploying an app starts
 * isolates in the image's workerd process, and workerd signals memory pressure for each new
 * isolate. V8 answered by dropping the compiled WebAssembly code of the server's own modules,
 * PGlite and the app compiler, which then compiled it again into new pages while the old pages
 * stayed resident. The process kept about 9 MB of executable memory for every app ever deployed.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { appsManifest, firstMigration } from "../support/apps-release.ts";
import { releasedServer } from "../support/docker-release-server.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, query, router, object } from "apps";
export default defineApp({ accounts: {} }, {
  tools: router({ count: query({ input: object({}) }, async ({ sql }) => sql.exec("SELECT count(*) AS n FROM notes").one().n) }),
});`,
  },
  firstMigration,
  appsManifest,
];

/** Resident executable memory outside any file: V8's JavaScript and WebAssembly code. */
const executableKilobytes = (smaps: string) => {
  let executable = false;
  let total = 0;
  for (const line of smaps.split("\n")) {
    const mapping = /^[0-9a-f]+-[0-9a-f]+ (\S+) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (mapping !== null) executable = mapping[1]!.includes("x") && mapping[2] === "";
    else if (executable && line.startsWith("Rss:")) total += Number(line.split(/\s+/)[1]);
  }
  return total;
};

it.live(
  "released image does not keep executable memory for each deployed app",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* releasedServer;
        // The product's workerd process; the telemetry collector runs its own.
        const executable = server
          .exec(
            'for process in /proc/[0-9]*; do read name < "$process/comm"; [ "$name" = workerd ] || continue; case "$(cat "$process/cmdline")" in *workerd.capnp*) cat "$process/smaps";; esac; done',
          )
          .pipe(Effect.map(executableKilobytes));
        const deploy = (count: number, from: number) =>
          Effect.forEach(
            Array.from({ length: count }, (_, index) => from + index),
            (index) => server.deploy(`Installed ${index}`, files),
          );
        // The first deployments compile the parts of the server's code they are the first to use.
        yield* deploy(3, 0);
        const before = yield* executable;
        expect(before, "the product's workerd process is found").toBeGreaterThan(0);
        const apps = 10;
        yield* deploy(apps, 3);
        const grown = (yield* executable) - before;
        // Each deployment kept about 9 MB before. Code first used by these deployments, and
        // short-lived isolates' code not yet released, stay well below 2 MB for each app.
        expect(
          grown / apps,
          `executable memory grew by ${Math.round(grown / 1024)} MB over ${apps} deployments`,
        ).toBeLessThan(2048);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  360_000,
);
