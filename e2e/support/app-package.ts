import { createServer, request as httpRequest } from "node:http";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { lockedArchive } from "./npm-registry.ts";

const releases = [
  "0.0.1-beta.0",
  "0.0.1-beta.1",
  "0.0.1-beta.4",
  "0.0.1-beta.5",
  "0.0.1-beta.9",
  "0.0.1-beta.14",
  "0.0.1-beta.22",
  "0.0.1-beta.33",
  "0.0.1-beta.59",
] as const;
export type Release = (typeof releases)[number];
const RuntimePackage = Schema.Record(Schema.String, Schema.Unknown);
const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));
class PackageFixtureFailed extends Schema.TaggedError<PackageFixtureFailed>()(
  "PackageFixtureFailed",
  { reason: Schema.String },
) {}

const publishedArchive = (version: Release = "0.0.1-beta.0") => lockedArchive("apps", version);

export const missingArchiveReason = "Archive withheld by its host";

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
            if (bytes === undefined) {
              response.writeHead(404, missingArchiveReason, { "Content-Type": "text/plain" });
              response.end(`${route} is not served here`);
              return;
            }
            response.writeHead(200, { "Content-Type": "application/octet-stream" });
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

const packDirectory = (source: string, destination: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
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

export const appPackageFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped();
  const { base, archives, requests } = yield* loopbackArchives;
  const pack = (source: string) => packDirectory(source, directory);

  const archive = yield* publishedArchive();
  archives.set("/apps-0.0.1-beta.0.tgz", archive);
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
  yield* fs.writeFileString(runtimeFile, JSON.stringify({ ...runtime, protocol: 99 }));
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

export const publishedRelease = (version: Release) =>
  Effect.gen(function* () {
    const { base, archives, requests } = yield* loopbackArchives;
    const route = `/apps-${version}.tgz`;
    archives.set(route, yield* publishedArchive(version));
    return { url: `${base}${route}`, route, requests };
  });

export const upstreamMarker = "UPSTREAM-REGISTRY-TEXT";

export const privateRegistryFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const suite = new URL(yield* Config.String("E2E_NPM_REGISTRY"));
  const directory = yield* fs.makeTempDirectoryScoped();
  const offsite = yield* loopbackArchives;
  const pack = (name: string, content: string, dependencies: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const source = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(source, "package.json"),
        JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", dependencies }),
      );
      yield* fs.writeFileString(path.join(source, "index.js"), content);
      return yield* packDirectory(source, directory);
    });
  const offsiteUrl = `${offsite.base}/offsite-fixture.tgz`;
  offsite.archives.set(
    "/offsite-fixture.tgz",
    yield* pack("offsite-fixture", 'export const value = "offsite-package";'),
  );
  const archives = new Map<string, Uint8Array>([
    [
      "/registry-fixture/-/registry-fixture-1.0.0.tgz",
      yield* pack("registry-fixture", 'export const value = "registry-package";'),
    ],
    [
      "/nested-fixture/-/nested-fixture-1.0.0.tgz",
      yield* pack("nested-fixture", 'export { value } from "offsite-fixture";', {
        "offsite-fixture": offsiteUrl,
      }),
    ],
    [
      "/manifest-fixture/-/manifest-fixture-1.0.0.tgz",
      yield* pack("manifest-fixture", 'export const value = "manifest-package";'),
    ],
  ]);
  const version = (
    name: string,
    tarball: string | undefined,
    dependencies?: Record<string, string>,
  ) => ({
    name,
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name,
        version: tarball === undefined ? upstreamMarker : "1.0.0",
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(tarball === undefined ? {} : { dist: { tarball } }),
      },
    },
  });
  const requests = new Map<string, number>();
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, response) => {
            const route = request.url ?? "/";
            requests.set(route, (requests.get(route) ?? 0) + 1);
            const base = `http://${request.headers.host ?? ""}`;
            const metadata: Record<string, unknown> = {
              "/registry-fixture": version(
                "registry-fixture",
                `${base}/registry-fixture/-/registry-fixture-1.0.0.tgz`,
              ),
              "/offsite-fixture": version("offsite-fixture", offsiteUrl),
              "/redirected-fixture": version(
                "redirected-fixture",
                `${base}/redirected-fixture.tgz`,
              ),
              "/nested-fixture": version(
                "nested-fixture",
                `${base}/nested-fixture/-/nested-fixture-1.0.0.tgz`,
                { "offsite-fixture": offsiteUrl },
              ),
              "/versionless-fixture": version("versionless-fixture", undefined),
              "/manifest-fixture": version(
                "manifest-fixture",
                `${base}/manifest-fixture/-/manifest-fixture-1.0.0.tgz`,
                { [`${upstreamMarker.toLowerCase()}-name`]: `${upstreamMarker}-range` },
              ),
            };
            const archive = archives.get(route);
            if (archive !== undefined) {
              response.writeHead(200, { "Content-Type": "application/octet-stream" });
              response.end(archive);
            } else if (route === "/redirected-fixture.tgz") {
              response.writeHead(302, { Location: offsiteUrl });
              response.end();
            } else if (route === "/malformed-fixture") {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(`{"versions": ${upstreamMarker}`);
            } else if (metadata[route] !== undefined) {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(JSON.stringify(metadata[route]));
            } else {
              const forwarded = httpRequest(
                {
                  host: suite.hostname,
                  port: suite.port,
                  path: route,
                  headers: { host: request.headers.host ?? "", accept: "application/json" },
                },
                (incoming) => {
                  response.writeHead(incoming.statusCode ?? 502, incoming.headers);
                  incoming.pipe(response);
                },
              );
              forwarded.once("error", () => {
                response.writeHead(502);
                response.end();
              });
              forwarded.end();
            }
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
      catch: () => new PackageFixtureFailed({ reason: "private registry listener" }),
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* new PackageFixtureFailed({ reason: "private registry address" });
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: Effect.sync(() => Object.fromEntries(requests)),
    offsite: offsite.requests,
  };
});
