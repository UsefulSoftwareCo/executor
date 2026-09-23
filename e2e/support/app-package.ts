/** Serve real npm archives through a scoped local registry boundary; no npm publication is needed. */
import { createServer } from "node:http";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const RuntimePackage = Schema.Struct({
  protocol: Schema.Number,
  version: Schema.String,
  server: Schema.Record(Schema.String, Schema.String),
  browser: Schema.Record(Schema.String, Schema.String),
});
const Package = Schema.Record(Schema.String, Schema.Unknown);
const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));
class PackageFixtureFailed extends Schema.TaggedError<PackageFixtureFailed>()(
  "PackageFixtureFailed",
  {},
) {}

/** The older fixture adds an export absent from the host, making accidental substitution observable. */
export const appPackageFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped();
  const root = yield* path.fromFileUrl(new URL("../../packages/apps/dist", import.meta.url));
  const archives = new Map<string, Uint8Array>();
  const requests = new Map<string, number>();
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, response) => {
            const route = request.url ?? "";
            requests.set(route, (requests.get(route) ?? 0) + 1);
            const bytes = archives.get(route);
            response.writeHead(bytes === undefined ? 404 : 200, {
              "Content-Type": "application/octet-stream",
            });
            response.end(bytes);
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
      catch: () => new PackageFixtureFailed(),
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* new PackageFixtureFailed();
  const base = `http://127.0.0.1:${address.port}`;
  for (const [name, protocol] of [
    ["older", 1],
    ["unsupported", 2],
  ] as const) {
    const copy = path.join(directory, name);
    yield* fs.copy(root, copy);
    const manifest = yield* fs
      .readFileString(path.join(copy, "package.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Package))));
    yield* fs.writeFileString(
      path.join(copy, "package.json"),
      JSON.stringify({
        ...manifest,
        version: "0.0.0-beta.0",
        dependencies: { "@executor-fixture/prebundled": `${base}/unused.tgz` },
      }),
    );
    const runtime = yield* fs
      .readFileString(path.join(copy, "runtime.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimePackage))));
    const marker = '\nexport const packageFixture = "older-package";\n';
    const marked = (modules: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const entry = modules["node_modules/apps/index.js"];
        if (entry === undefined) return yield* new PackageFixtureFailed();
        return { ...modules, "node_modules/apps/index.js": entry + marker };
      });
    yield* fs.writeFileString(
      path.join(copy, "runtime.json"),
      JSON.stringify({
        ...runtime,
        server: yield* marked(runtime.server),
        browser: yield* marked(runtime.browser),
        version: "0.0.0-beta.0",
        protocol,
      }),
    );
    const packed = yield* processes
      .string(
        ChildProcess.make("npm", ["pack", copy, "--json", "--pack-destination", directory], {
          stdout: "pipe",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    archives.set(`/${name}.tgz`, yield* fs.readFile(path.join(directory, packed[0].filename)));
  }
  for (const [name, dependencies, content] of [
    ["transitive-fixture", {}, 'export const value = "transitive-package";'],
    [
      "direct-fixture",
      { "transitive-fixture": `${base}/transitive-fixture.tgz` },
      'export { value } from "transitive-fixture";',
    ],
  ] as const) {
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js", dependencies }),
    );
    yield* fs.writeFileString(path.join(directory, "index.js"), content);
    const packed = yield* processes
      .string(
        ChildProcess.make("npm", ["pack", directory, "--json", "--pack-destination", directory], {
          stdout: "pipe",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    archives.set(`/${name}.tgz`, yield* fs.readFile(path.join(directory, packed[0].filename)));
  }
  return {
    older: `${base}/older.tgz`,
    direct: `${base}/direct-fixture.tgz`,
    unused: `${base}/unused.tgz`,
    requests: Effect.sync(() => Object.fromEntries(requests)),
    unsupported: `http://127.0.0.1:${address.port}/unsupported.tgz`,
  };
});
