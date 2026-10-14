/**
 * A local npm registry for product builds. It serves the `apps` package staged from this checkout
 * (`bun run e2e:prepare`) as the version the hosts ship, which new apps pin, so scenarios run before
 * that version is published.
 *
 * The suite's registry (`lockedNpmRegistry`) serves every other package only from
 * `e2e/npm-packages.json`: the versions the scenarios install, downloaded by `e2e:prepare` and
 * checked against their pinned integrity. Scenarios never reach the public registry, and a package
 * or version outside the lock is refused with a 404 that names the lock. Release checks, which do
 * not run `e2e:prepare`, use the forwarding registries, which pass every other request to the
 * public registry unchanged. Products on this machine reach it on loopback; released images reach
 * it from their containers through Docker's host gateway.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const upstream = "https://registry.npmjs.org";
/**
 * A synthetic package whose metadata response starts and never finishes, so a build that imports
 * it leaves the compiler without an answer, as a lost compiler isolate does.
 */
export const stalledPackage = "@executor-fixture/stalled-package";
const stalledPath = `/@${encodeURIComponent(stalledPackage.slice(1))}`;
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Manifest = Schema.Struct({ name: Schema.Literal("apps"), version: Schema.NonEmptyString });
class RegistryFailed extends Schema.TaggedError<RegistryFailed>()("RegistryFailed", {
  reason: Schema.String,
}) {}

/** `e2e/npm-packages.json`, written by `node scripts/e2e-npm-packages.ts --update`. */
const Lock = Schema.Struct({
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({
      distTags: Schema.Record(Schema.String, Schema.String),
      versions: Schema.Record(
        Schema.String,
        Schema.Struct({
          integrity: Schema.String,
          dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
    }),
  ),
});
type Lock = typeof Lock.Type;

const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** The pinned packages and a reader for their archives, which `e2e:prepare` downloads. */
const lockedPackages = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.resolve(".local/test-runtime/npm");
  if (!(yield* fs.exists(directory)))
    return yield* new RegistryFailed({
      reason: "Run bun run e2e:prepare, or node scripts/e2e-npm-packages.ts, to download them.",
    });
  const lock = yield* fs
    .readFileString(path.resolve("e2e/npm-packages.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Lock))));
  const read = (name: string, version: string) =>
    Effect.gen(function* () {
      const integrity = lock.packages[name]?.versions[version]?.integrity;
      if (integrity === undefined)
        return yield* new RegistryFailed({
          reason: `${name}@${version} is not in e2e/npm-packages.json`,
        });
      // The same file name scripts/e2e-npm-packages.ts writes.
      const bytes = yield* fs.readFile(
        path.join(directory, `${name.replace("/", "+")}-${version}.tgz`),
      );
      if (integrityOf(bytes) !== integrity)
        return yield* new RegistryFailed({
          reason: `${name}@${version} does not match its pinned integrity; run bun run e2e:prepare`,
        });
      return bytes;
    });
  return { lock, read };
});

/** A pinned archive from `e2e/npm-packages.json`, read from disk and checked against its integrity. */
export const lockedArchive = (name: string, version: string) =>
  lockedPackages.pipe(Effect.flatMap(({ read }) => read(name, version)));

type Reply = { readonly status: number; readonly type: string; readonly body: Uint8Array };

const json = (status: number, value: unknown): Reply => ({
  status,
  type: "application/json",
  body: new TextEncoder().encode(JSON.stringify(value)),
});

/** Where npm serves a version's archive, relative to the registry. */
const tarballPath = (name: string, version: string) =>
  `/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;

interface Staged {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly tarballPath: string;
  readonly entry: (base: string) => typeof JsonObject.Type;
}

/**
 * Serve the staged `apps` and the pinned packages. A packument lists only pinned versions, so every
 * range resolves to the version it resolved to when the lock was written.
 */
const lockedReply = (staged: Staged) =>
  Effect.gen(function* () {
    const { lock, read } = yield* lockedPackages;
    const archives = new Map(
      Object.entries(lock.packages).flatMap(([name, entry]) =>
        Object.keys(entry.versions).map(
          (version) => [tarballPath(name, version), { name, version }] as const,
        ),
      ),
    );
    const packument = (
      name: string,
      base: string,
      pinned: Lock["packages"][string] | undefined,
    ) => ({
      name,
      "dist-tags": pinned?.distTags ?? {},
      versions: {
        ...Object.fromEntries(
          Object.entries(pinned?.versions ?? {}).map(([version, entry]) => [
            version,
            {
              name,
              version,
              ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
              dist: { tarball: `${base}${tarballPath(name, version)}`, integrity: entry.integrity },
            },
          ]),
        ),
        ...(name === "apps" ? { [staged.version]: staged.entry(base) } : {}),
      },
    });
    const replies: Replies = (url, base) => {
      if (url === staged.tarballPath)
        return Effect.succeed({
          status: 200,
          type: "application/octet-stream",
          body: staged.bytes,
        });
      const archive = archives.get(url);
      if (archive !== undefined)
        return read(archive.name, archive.version).pipe(
          Effect.map((body) => ({ status: 200, type: "application/octet-stream", body })),
          Effect.catch((error) =>
            Console.error(`e2e npm registry: ${error.message}`).pipe(
              Effect.as(json(500, { error: error.message })),
            ),
          ),
        );
      const name = decodeURIComponent(url.slice(1));
      const pinned = lock.packages[name];
      if (pinned !== undefined || name === "apps")
        return Effect.succeed(json(200, packument(name, base, pinned)));
      const error = `${name} is not in e2e/npm-packages.json. Add it to the roots in scripts/e2e-npm-packages.ts and run node scripts/e2e-npm-packages.ts --update.`;
      return Console.error(`e2e npm registry: ${error}`).pipe(Effect.as(json(404, { error })));
    };
    return replies;
  });

/** Serve the staged `apps` and forward every other request to the public registry unchanged. */
const forwardingReply = (staged: Staged) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const forward = (url: string) =>
      Effect.gen(function* () {
        const response = yield* http.get(`${upstream}${url}`);
        return {
          status: response.status,
          type: response.headers["content-type"] ?? "application/json",
          body: new Uint8Array(yield* response.arrayBuffer),
        } satisfies Reply;
      }).pipe(
        Effect.scoped,
        Effect.catch(() =>
          Effect.succeed({
            status: 502,
            type: "text/plain",
            body: new Uint8Array(),
          } satisfies Reply),
        ),
      );
    const replies: Replies = (url, base) =>
      Effect.gen(function* () {
        if (url === staged.tarballPath)
          return {
            status: 200,
            type: "application/octet-stream",
            body: staged.bytes,
          } satisfies Reply;
        if (url !== "/apps") return yield* forward(url);
        // Published versions stay as npm serves them; the staged package is added as its version.
        const published = yield* forward(url);
        const packument: typeof JsonObject.Type =
          published.status === 200
            ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
                new TextDecoder().decode(published.body),
              ).pipe(Effect.orElseSucceed((): typeof JsonObject.Type => ({})))
            : {};
        const versions = Schema.is(JsonObject)(packument.versions) ? packument.versions : {};
        return json(200, {
          ...packument,
          name: "apps",
          versions: { ...versions, [staged.version]: staged.entry(base) },
        });
      });
    return replies;
  });

type Replies = (url: string, base: string) => Effect.Effect<Reply>;

/**
 * Start the registry for the scope on `hostname` and return the port it listens on. `replies`
 * answers every request except the stalled package's.
 */
const serveRegistry = Effect.fnUntraced(function* <E, R>(
  hostname: string,
  replies: (staged: Staged) => Effect.Effect<Replies, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const archive = path.resolve(".local/test-runtime/apps.tgz");
  if (!(yield* fs.exists(archive)))
    return yield* new RegistryFailed({
      reason: "Run bun run e2e:prepare, or apps:build and e2e:apps, to stage apps first.",
    });
  const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject));
  const text = yield* processes.string(
    // A relative archive path: GNU tar on Windows reads a drive letter as a remote host.
    ChildProcess.make("tar", ["-xzOf", path.basename(archive), "package/package.json"], {
      cwd: path.dirname(archive),
    }),
  );
  const raw = yield* decodeJson(text);
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(raw);
  const bytes = yield* fs.readFile(archive);
  const staged = {
    version: manifest.version,
    bytes,
    tarballPath: tarballPath("apps", manifest.version),
    /** The staged version's packument entry, with its archive at the origin the client addressed. */
    entry: (base: string) => ({
      ...raw,
      dist: {
        tarball: `${base}${tarballPath("apps", manifest.version)}`,
        integrity: integrityOf(bytes),
        shasum: createHash("sha1").update(bytes).digest("hex"),
      },
    }),
  };
  const reply = yield* replies(staged);

  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, response) => {
            const url = request.url ?? "/";
            if (url.toLowerCase() === stalledPath.toLowerCase()) {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.write("{");
              return;
            }
            // Archive links use the origin the client addressed, loopback or a container's gateway.
            const base = `http://${request.headers.host ?? ""}`;
            // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- node:http request handlers are plain callbacks
            Effect.runPromise(reply(url.split("?")[0] ?? "/", base)).then(
              (result) => {
                response.writeHead(result.status, { "Content-Type": result.type });
                response.end(result.body);
              },
              () => {
                response.writeHead(500);
                response.end();
              },
            );
          });
          server.once("error", reject);
          server.listen(0, hostname, () => resolve(server));
        }),
      catch: () => new RegistryFailed({ reason: "registry listener" }),
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            // Stalled responses stay open until the registry stops.
            server.closeAllConnections();
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* new RegistryFailed({ reason: "registry address" });
  return { port: address.port, version: manifest.version };
});

const loopback = ({ port, version }: { readonly port: number; readonly version: string }) => ({
  url: `http://127.0.0.1:${port}`,
  version,
});

/**
 * Start the suite's registry for the scope on loopback and return its origin. It serves only the
 * staged `apps` and `e2e/npm-packages.json`, so no scenario depends on the public registry.
 */
export const lockedNpmRegistry = serveRegistry("127.0.0.1", lockedReply).pipe(Effect.map(loopback));

/**
 * Start a forwarding registry for the scope on loopback and return its origin. Release checks use
 * it: they install released archives' whole dependency trees and do not run `e2e:prepare`.
 */
export const localNpmRegistry = serveRegistry("127.0.0.1", forwardingReply).pipe(
  Effect.map(loopback),
);

/** The name released images resolve to the machine running the suite. */
const gatewayHost = "npm-registry.e2e.internal";

/**
 * Start the registry for the scope where released images can reach it. Docker's `host-gateway`
 * is the host's address on the container network, so the registry listens on every interface.
 * `docker` holds the `docker run` arguments that point a product container at it.
 */
export const containerNpmRegistry = serveRegistry("0.0.0.0", forwardingReply).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.map(({ port, version }) => {
    const url = `http://${gatewayHost}:${port}`;
    return {
      url,
      version,
      docker: [
        "--add-host",
        `${gatewayHost}:host-gateway`,
        "--env",
        `EXECUTOR_NPM_REGISTRY=${url}`,
      ] as const,
    };
  }),
);
