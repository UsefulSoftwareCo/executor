import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const upstream = "https://registry.npmjs.org";

export const registryForwardsLog = ".local/releases/registry-forwards.jsonl";
export const stalledPackage = "@executor-fixture/stalled-package";
const stalledPath = `/@${encodeURIComponent(stalledPackage.slice(1))}`;

export const largeModulePackage = {
  name: "@executor-fixture/large-module",
  version: "1.0.0",
  bytes: 3_000_000,
} as const;
const largeModule = (() => {
  const entry = (at: number) =>
    `  { id: ${at}, name: "item ${at}", tags: ["a", "b"], nested: { x: ${at}, y: "z" } },\n`;
  const open = "const items = [\n";
  const close = "];\nexport const count = items.length;\n";
  const entries: string[] = [];
  let used = open.length + close.length + 3;
  while (used + entry(entries.length).length <= largeModulePackage.bytes) {
    used += entry(entries.length).length;
    entries.push(entry(entries.length));
  }
  return {
    source: `${open}${entries.join("")}${close}//${" ".repeat(largeModulePackage.bytes - used)}\n`,
    count: entries.length,
  };
})();
export const largeModuleCount = largeModule.count;
const packArchive = (files: Readonly<Record<string, string>>) => {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(" ", 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(blocks);
  return Effect.promise(() =>
    new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  ).pipe(Effect.map((gzipped) => new Uint8Array(gzipped)));
};
const largeModuleArchive = packArchive({
  "package.json": JSON.stringify({
    name: largeModulePackage.name,
    version: largeModulePackage.version,
    type: "module",
    main: "index.js",
    exports: { ".": "./index.js" },
  }),
  "index.js": largeModule.source,
});
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Manifest = Schema.Struct({ name: Schema.Literal("apps"), version: Schema.NonEmptyString });
class RegistryFailed extends Schema.TaggedError<RegistryFailed>()("RegistryFailed", {
  reason: Schema.String,
}) {}

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

export const lockedArchive = (name: string, version: string) =>
  lockedPackages.pipe(Effect.flatMap(({ read }) => read(name, version)));

type Reply = { readonly status: number; readonly type: string; readonly body: Uint8Array };

const json = (status: number, value: unknown): Reply => ({
  status,
  type: "application/json",
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const tarballPath = (name: string, version: string) =>
  `/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;

interface Staged {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly tarballPath: string;
  readonly entry: (base: string) => typeof JsonObject.Type;
}

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
    const largeArchivePath = tarballPath(largeModulePackage.name, largeModulePackage.version);
    const largeArchive = yield* largeModuleArchive;
    const replies: Replies = (url, base) => {
      if (url === staged.tarballPath)
        return Effect.succeed({
          status: 200,
          type: "application/octet-stream",
          body: staged.bytes,
        });
      if (url === largeArchivePath)
        return Effect.succeed({
          status: 200,
          type: "application/octet-stream",
          body: largeArchive,
        });
      if (decodeURIComponent(url.slice(1)) === largeModulePackage.name)
        return Effect.succeed(
          json(200, {
            name: largeModulePackage.name,
            "dist-tags": { latest: largeModulePackage.version },
            versions: {
              [largeModulePackage.version]: {
                name: largeModulePackage.name,
                version: largeModulePackage.version,
                dist: {
                  tarball: `${base}${largeArchivePath}`,
                  integrity: integrityOf(largeArchive),
                },
              },
            },
          }),
        );
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

type Outcome = { ms?: number; status?: number; bytes?: number; error?: string };

type Forward = { at: string; url: string; started: number } & Outcome;

const forwardingReply = (staged: Staged, fetches: Array<Forward> = []) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const now = Date.now();
        const unfinished = fetches.filter((fetch) => fetch.ms === undefined);
        yield* Console.log(
          `Forwarding registry: ${fetches.length - unfinished.length} upstream fetches finished, ${unfinished.length} never finished.`,
        );
        const slowest = fetches
          .filter((fetch) => fetch.ms !== undefined)
          .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
          .slice(0, 5);
        for (const fetch of slowest)
          yield* Console.log(`  ${fetch.ms} ms ${fetch.error ?? fetch.status} ${fetch.url}`);
        for (const fetch of unfinished)
          yield* Console.log(
            `  NEVER FINISHED: waited ${now - fetch.started} ms when the registry stopped: ${fetch.url}`,
          );
        if (fetches.length === 0) return;
        const lines = fetches
          .map(({ started, ...fetch }) =>
            JSON.stringify(fetch.ms === undefined ? { ...fetch, waitedMs: now - started } : fetch),
          )
          .join("\n");
        const written = yield* fs
          .makeDirectory(path.dirname(registryForwardsLog), { recursive: true })
          .pipe(
            Effect.andThen(fs.writeFileString(registryForwardsLog, `${lines}\n`, { flag: "a" })),
            Effect.interruptible,
            Effect.timeoutOption("2 seconds"),
            Effect.map(
              Option.match({
                onNone: () => "it took longer than 2 seconds",
                onSome: () => undefined,
              }),
            ),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
        if (written !== undefined)
          yield* Console.error(
            `Forwarding registry: could not write ${registryForwardsLog} (${written}); its records:\n${lines}`,
          );
      }),
    );
    const forward = (url: string) =>
      Effect.suspend(() => {
        const started = Date.now();
        const fetch = { at: new Date(started).toISOString(), url: `${upstream}${url}`, started };
        fetches.push(fetch);
        const end = (outcome: Omit<Outcome, "ms">) =>
          Object.assign(fetch, { ms: Date.now() - started, ...outcome });
        return Effect.gen(function* () {
          const response = yield* http.get(fetch.url);
          const body = new Uint8Array(yield* response.arrayBuffer);
          end({ status: response.status, bytes: body.byteLength });
          return {
            status: response.status,
            type: response.headers["content-type"] ?? "application/json",
            body,
          } satisfies Reply;
        }).pipe(
          Effect.scoped,
          Effect.catch((error) =>
            Effect.sync(() => {
              end({ error: error._tag });
              return { status: 502, type: "text/plain", body: new Uint8Array() } satisfies Reply;
            }),
          ),
        );
      });
    const replies: Replies = (url, base) =>
      Effect.gen(function* () {
        if (url === staged.tarballPath)
          return {
            status: 200,
            type: "application/octet-stream",
            body: staged.bytes,
          } satisfies Reply;
        if (url !== "/apps") return yield* forward(url);
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

export const lockedNpmRegistry = serveRegistry("127.0.0.1", lockedReply).pipe(Effect.map(loopback));

export const localNpmRegistry = serveRegistry("127.0.0.1", forwardingReply).pipe(
  Effect.map(loopback),
);

export const pinnedDownloadCommand = (file: string) =>
  `node scripts/e2e-npm-packages.ts --only ${file}`;

export const desktopReleasePackagesFile = "e2e/desktop-release-packages.json";

export interface PinnedRegistryRecord {
  readonly forwards: ReadonlyArray<string>;
  readonly archives: Readonly<Record<string, number>>;
}

export const pinnedNpmRegistry = (file: string, required: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { lock, read } = yield* lockedPackages;
    for (const pinned of required) {
      const at = pinned.lastIndexOf("@");
      yield* read(pinned.slice(0, at), pinned.slice(at + 1)).pipe(
        Effect.mapError(
          (error) =>
            new RegistryFailed({
              reason: `${pinned} is not ready to serve (${error._tag === "RegistryFailed" ? error.reason : error.message}). Download it before the scenario: ${pinnedDownloadCommand(file)}`,
            }),
        ),
      );
    }
    const forwards: Array<Forward> = [];
    const archives: Record<string, number> = {};
    const archivePaths = new Map(
      Object.entries(lock.packages).flatMap(([name, entry]) =>
        Object.keys(entry.versions).map(
          (version) => [tarballPath(name, version), `${name}@${version}`] as const,
        ),
      ),
    );
    const registry = yield* serveRegistry("127.0.0.1", (staged) =>
      Effect.gen(function* () {
        const locked = yield* lockedReply(staged);
        const forwarded = yield* forwardingReply(staged, forwards);
        const replies: Replies = (url, base) => {
          const archive = archivePaths.get(url);
          if (archive !== undefined) archives[archive] = (archives[archive] ?? 0) + 1;
          const name = decodeURIComponent(url.slice(1));
          return archive !== undefined ||
            url === staged.tarballPath ||
            name === "apps" ||
            lock.packages[name] !== undefined
            ? locked(url, base)
            : forwarded(url, base);
        };
        return replies;
      }),
    ).pipe(Effect.map(loopback));
    return {
      ...registry,
      record: Effect.sync((): PinnedRegistryRecord => ({
        forwards: forwards.map((fetch) => fetch.url),
        archives: { ...archives },
      })),
    };
  });

const gatewayHost = "npm-registry.e2e.internal";

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
