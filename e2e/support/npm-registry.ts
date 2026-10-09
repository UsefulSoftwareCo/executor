/**
 * A local npm registry for product builds. It serves the `apps` package staged from this checkout
 * (`bun run e2e:prepare`) as the version the hosts ship, which new apps pin, so scenarios run before
 * that version is published. Every other request, including every published `apps` release, is
 * forwarded to the public registry unchanged. Products on this machine reach it on loopback;
 * released images reach it from their containers through Docker's host gateway.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Effect, FileSystem, Path, Schema } from "effect";
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

type Reply = { readonly status: number; readonly type: string; readonly body: Uint8Array };

/** One version this registry serves itself. */
interface Served {
  readonly version: string;
  readonly manifest: typeof JsonObject.Type;
  readonly bytes: Uint8Array;
}

/** Start the registry for the scope on `hostname` and return the port it listens on. */
const serveRegistry = Effect.fnUntraced(function* (hostname: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
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
  const staged: Served = {
    version: manifest.version,
    manifest: raw,
    bytes: yield* fs.readFile(archive),
  };

  const served = [staged].map((entry) => ({
    ...entry,
    tarballPath: `/apps/-/apps-${entry.version}.tgz`,
    integrity: `sha512-${createHash("sha512").update(entry.bytes).digest("base64")}`,
    shasum: createHash("sha1").update(entry.bytes).digest("hex"),
  }));

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
        Effect.succeed({ status: 502, type: "text/plain", body: new Uint8Array() } satisfies Reply),
      ),
    );

  const reply = (url: string, base: string): Effect.Effect<Reply> =>
    Effect.gen(function* () {
      const archive = served.find((entry) => entry.tarballPath === url);
      if (archive !== undefined)
        return {
          status: 200,
          type: "application/octet-stream",
          body: archive.bytes,
        } satisfies Reply;
      if (url !== "/apps") return yield* forward(url);
      // Published versions stay as npm serves them; each served package is added as its version.
      const published = yield* forward(url);
      const packument: typeof JsonObject.Type =
        published.status === 200
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
              new TextDecoder().decode(published.body),
            ).pipe(Effect.orElseSucceed((): typeof JsonObject.Type => ({})))
          : {};
      const versions = Schema.is(JsonObject)(packument.versions) ? packument.versions : {};
      const body = JSON.stringify({
        ...packument,
        name: "apps",
        versions: {
          ...versions,
          ...Object.fromEntries(
            served.map((entry) => [
              entry.version,
              {
                ...entry.manifest,
                dist: {
                  tarball: `${base}${entry.tarballPath}`,
                  integrity: entry.integrity,
                  shasum: entry.shasum,
                },
              },
            ]),
          ),
        },
      });
      return {
        status: 200,
        type: "application/json",
        body: new TextEncoder().encode(body),
      } satisfies Reply;
    });

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
            Effect.runPromise(reply(url, base)).then(
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

/** Start the registry for the scope on loopback and return its origin. */
export const localNpmRegistry = serveRegistry("127.0.0.1").pipe(
  Effect.map(({ port, version }) => ({ url: `http://127.0.0.1:${port}`, version })),
);

/** The name released images resolve to the machine running the suite. */
const gatewayHost = "npm-registry.e2e.internal";

/**
 * Start the registry for the scope where released images can reach it. Docker's `host-gateway`
 * is the host's address on the container network, so the registry listens on every interface.
 * `docker` holds the `docker run` arguments that point a product container at it.
 */
export const containerNpmRegistry = serveRegistry("0.0.0.0").pipe(
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
