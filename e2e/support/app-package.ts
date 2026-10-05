/** Serve real npm archives through a scoped local registry boundary; no npm publication is needed. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * Published apps versions, exactly as npm serves them. beta.0 and beta.1 speak host protocol 1,
 * beta.4 protocol 2 and beta.5 protocol 3.
 */
const releases = {
  "0.0.1-beta.0":
    "sha512-Rt8WY1dx0NlBEkAsy+72p5Q0ODt/bk6PnuFsZCzZY0mvESqepZrSe86H66cmzSNGjiAlLO4U7rU1LJQWU8tGZQ==",
  "0.0.1-beta.1":
    "sha512-2a6R4JU9TAb0MaS38pjBQPAE5c/T/nOT+YF1d5xZ34t35z5KSI2j8DrTyrJIK06eTYAhu28P16m+mBHnomnhzg==",
  "0.0.1-beta.4":
    "sha512-EeEOQNvUyUKyuKBXiK4cnZd4U6o4HwduPFsaGBTEqO5VorXyxWBPwmJU0Opt+3eCK4kIfmmmzBKql7SXm8j9ng==",
  "0.0.1-beta.5":
    "sha512-d9tAdBVDtm8j8ubXcqPWLEEOBwz4hDPXxMg93hxqFWjeGAfdu+5T9HHrJ4FlVhenrzeyqB/hvD8p+9D+ZNFEFw==",
} as const;
type Release = keyof typeof releases;
const RuntimePackage = Schema.Record(Schema.String, Schema.Unknown);
const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));
class PackageFixtureFailed extends Schema.TaggedError<PackageFixtureFailed>()(
  "PackageFixtureFailed",
  { reason: Schema.String },
) {}

/** Download a published archive and refuse any bytes that do not match its registry integrity. */
const publishedArchive = (version: Release = "0.0.1-beta.0") =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(`https://registry.npmjs.org/apps/-/apps-${version}.tgz`);
    if (response.status !== 200)
      return yield* new PackageFixtureFailed({ reason: `npm returned ${response.status}` });
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== releases[version])
      return yield* new PackageFixtureFailed({ reason: `apps@${version} integrity mismatch` });
    return bytes;
  }).pipe(Effect.scoped);

/** Serve archives on loopback for the scope, counting each request path. */
const loopbackArchives = Effect.gen(function* () {
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
      catch: () => new PackageFixtureFailed({ reason: "registry listener" }),
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* new PackageFixtureFailed({ reason: "registry address" });
  const base = `http://127.0.0.1:${address.port}`;
  return { base, archives, requests: Effect.sync(() => Object.fromEntries(requests)) };
});

/** `npm pack` one package directory without running its scripts, returning the archive bytes. */
const packDirectory = (source: string, destination: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Windows npm is a shell wrapper. Invoke its JavaScript entry with Node, without a shell.
    const npm =
      process.platform === "win32"
        ? {
            command: process.execPath,
            prefix: [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")],
          }
        : { command: "npm", prefix: [] };
    const packed = yield* processes
      .string(
        ChildProcess.make(
          npm.command,
          [
            ...npm.prefix,
            "pack",
            source,
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            destination,
          ],
          { stdout: "pipe", stderr: "ignore" },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    return yield* fs.readFile(path.join(destination, packed[0].filename));
  });

/**
 * The published `apps@0.0.1-beta.0`, and a copy whose `runtime.json` declares protocol 8. The real
 * archive predates exports the host added later, so linking only current exports would fail.
 */
export const appPackageFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped();
  const { base, archives, requests } = yield* loopbackArchives;
  const pack = (source: string) => packDirectory(source, directory);

  const archive = yield* publishedArchive();
  archives.set("/apps-0.0.1-beta.0.tgz", archive);
  // Only the declared protocol differs, so the rejection comes from the protocol check alone.
  const extracted = path.join(directory, "unsupported");
  yield* fs.makeDirectory(extracted);
  yield* fs.writeFile(path.join(directory, "published.tgz"), archive);
  yield* processes.string(
    ChildProcess.make("tar", ["-xzf", path.join(directory, "published.tgz"), "-C", extracted]),
  );
  const runtimeFile = path.join(extracted, "package", "runtime.json");
  const runtime = yield* fs
    .readFileString(runtimeFile)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimePackage))));
  yield* fs.writeFileString(runtimeFile, JSON.stringify({ ...runtime, protocol: 9 }));
  archives.set("/unsupported.tgz", yield* pack(path.join(extracted, "package")));

  for (const [name, dependencies, content] of [
    ["transitive-fixture", {}, 'export const value = "transitive-package";'],
    [
      "direct-fixture",
      { "transitive-fixture": `${base}/transitive-fixture.tgz` },
      'export { value } from "transitive-fixture";',
    ],
  ] as const) {
    const source = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(source, "package.json"),
      JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js", dependencies }),
    );
    yield* fs.writeFileString(path.join(source, "index.js"), content);
    archives.set(`/${name}.tgz`, yield* pack(source));
  }
  return {
    published: `${base}/apps-0.0.1-beta.0.tgz`,
    direct: `${base}/direct-fixture.tgz`,
    unused: `${base}/unused.tgz`,
    requests,
    unsupported: `${base}/unsupported.tgz`,
  };
});

/**
 * A published `apps` release served on loopback, so the product resolves it without depending on
 * the npm registry. Hosts resolve the bare version from npm in production.
 */
export const publishedRelease = (version: Release) =>
  Effect.gen(function* () {
    const { base, archives, requests } = yield* loopbackArchives;
    const route = `/apps-${version}.tgz`;
    archives.set(route, yield* publishedArchive(version));
    return { url: `${base}${route}`, route, requests };
  });
