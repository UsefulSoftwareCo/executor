/** The app isolate's own network, proved against a real listening loopback port. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { createAppRuntime } from "../src/index.ts";
import { workerdApps } from "../src/node.ts";

/** A database makes the host run the app in a Durable Object facet instead of a loaded worker. */
const appSource = (
  database: boolean,
) => `import { defineApp, defineDatabase, object, query, string, table } from "apps";
export default defineApp({ accounts: {}${database ? ", database: defineDatabase({ notes: table({ body: string() }) })" : ""} }, {
  name: "Egress probe",
  queries: {
    probe: query({ input: object({ url: string() }), output: string() }, async ({ fetch }, { url }) => {
      try {
        const response = await fetch(url);
        return \`reached:\${response.status}\`;
      } catch (error) {
        return \`refused:\${String(error)}\`;
      }
    }),
  },
});
`;

/** Build and run the probe in a workerd host configured like local or like self-host. */
const probe = (options: {
  readonly allowPrivateAppFetch: boolean;
  readonly database: boolean;
  readonly url: string;
  readonly selfOrigin?: { readonly origin: string; readonly address: string };
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const blobs = memoryBlobStore();
      const { runtime } = yield* workerdApps({
        directory: `${directory}/workerd`,
        blobs,
        // No workflow runs here; the host executor is never asked for one.
        executor: Effect.never,
        allowPrivateAppFetch: options.allowPrivateAppFetch,
        ...(options.selfOrigin === undefined ? {} : { selfOrigin: options.selfOrigin }),
      });
      const apps = createAppRuntime({ runtime, blobs });
      return yield* Effect.promise(async () => {
        const { build } = await apps.build({
          files: [{ path: "index.ts", content: appSource(options.database) }],
        });
        return String(
          await apps.call({
            app: "egress-probe",
            build,
            database: options.database,
            accounts: {},
            tool: "queries.probe",
            input: { url: options.url },
          }),
        );
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

for (const database of [false, true]) {
  test(
    `a ${database ? "database" : "stateless"} app isolate reaches a listening loopback port only when private app fetch is allowed`,
    { timeout: 180_000 },
    async (t) => {
      const server = createServer((_request, response) => {
        response.writeHead(204).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/`;

      assert.equal(await probe({ allowPrivateAppFetch: true, database, url }), "reached:204");
      const refused = await probe({ allowPrivateAppFetch: false, database, url });
      assert.match(
        refused,
        /^refused:/,
        `the isolate reached ${url} with private app fetch off: ${refused}`,
      );
    },
  );
}

test(
  "an app isolate reaches the dashboard origin through the host when private app fetch is off",
  { timeout: 180_000 },
  async (t) => {
    const hosts: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? "");
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    // A public-looking name that no resolver answers, like a tailnet name outside the tailnet.
    const selfOrigin = {
      origin: "https://nexus.example.ts.net",
      address: `127.0.0.1:${address.port}`,
    };

    for (const database of [false, true])
      assert.equal(
        await probe({
          allowPrivateAppFetch: false,
          database,
          selfOrigin,
          url: "https://nexus.example.ts.net/api/viewer",
        }),
        "reached:204",
      );
    assert.deepEqual(hosts, ["nexus.example.ts.net", "nexus.example.ts.net"]);
    const other = await probe({
      allowPrivateAppFetch: false,
      database: false,
      selfOrigin,
      url: `http://127.0.0.1:${address.port}/`,
    });
    assert.match(other, /^refused:/, `the isolate reached another private origin: ${other}`);
  },
);
