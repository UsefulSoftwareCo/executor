/** Binary ui/public files are ordinary app source, copied to the host's store on deploy and served. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { appsManifest, withApps } from "../support/apps-release.ts";

interface PublicFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A Git blob's object ID, which names a public file's bytes as its ETag. */
const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** A WebAssembly module exporting `add(a, b)`. */
const addWasm = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
/** A one-pixel PNG. */
const pixel = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const text = (value: string) => new TextEncoder().encode(value);
/** Bytes that are not valid UTF-8, so they could never travel as text source. */
const binary = (prefix: string, size: number) => {
  const bytes = randomBytes(size);
  bytes.set(text(prefix));
  bytes[prefix.length] = 0xff;
  return Uint8Array.from(bytes);
};

/** Many small prebuilt chunks, as a bundler's output has. */
const chunks: PublicFile[] = Array.from({ length: 300 }, (_, index) => ({
  path: `assets/chunk-${index}.js`,
  bytes: text(`export const chunk = ${index};\n`),
  contentType: "text/javascript",
}));

const publicFiles = (version: string): PublicFile[] => [
  // A prebuilt entry the page loads as it is. It needs the wasm served as application/wasm.
  {
    path: "assets/main.js",
    bytes:
      text(`const { instance } = await WebAssembly.instantiateStreaming(fetch("/wasm/add.wasm"));
const { chunk } = await import("./chunk-299.js");
document.body.dataset.sum = String(instance.exports.add(2, 3));
document.body.dataset.chunk = String(chunk);
document.body.dataset.version = ${JSON.stringify(version)};
`),
    contentType: "text/javascript",
  },
  { path: "wasm/add.wasm", bytes: addWasm, contentType: "application/wasm" },
  { path: "images/pixel.png", bytes: pixel, contentType: "image/png" },
  { path: "fonts/display.woff2", bytes: binary("wOF2", 48_000), contentType: "font/woff2" },
  { path: "audio/chime.mp3", bytes: binary("ID3", 200_000), contentType: "audio/mpeg" },
  { path: "models/scene.glb", bytes: binary("glTF", 64_000), contentType: "model/gltf-binary" },
  {
    path: "manifest.webmanifest",
    bytes: text(`{"name":"Public files ${version}"}`),
    contentType: "application/manifest+json",
  },
  {
    path: "pages/about.html",
    bytes: text("<!doctype html><p>About</p>"),
    contentType: "text/html",
  },
  // Larger than the whole source budget for code on its own.
  {
    path: "media/large.bin",
    bytes: binary("BIG", 20 * 1024 * 1024),
    contentType: "application/octet-stream",
  },
  { path: "version.txt", bytes: text(version), contentType: "text/plain" },
  ...chunks,
];

const indexSource = `import { defineApp, router } from "apps";\nexport default defineApp({}, { tools: router({}) });\n`;
const page = `<!doctype html><html><head><title>Public files</title>
<link rel="manifest" href="/manifest.webmanifest">
<script type="module" src="/assets/main.js"></script></head>
<body><main><h1>Public files</h1><img alt="Pixel" src="images/pixel.png"></main></body></html>`;

const App = Schema.Struct({ id: Schema.String, activeDeployment: Schema.NullOr(Schema.String) });
const Created = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const Deployed = Schema.fromJsonString(
  Schema.Struct({ deployment: Schema.Struct({ id: Schema.String }) }),
);
const SourceEntry = Schema.Union([
  Schema.Struct({ path: Schema.String, object: Schema.String, size: Schema.Number }),
  Schema.Struct({ path: Schema.String, content: Schema.String }),
]);
const Workspace = Schema.Struct({
  revision: Schema.Struct({ code: Schema.String, commit: Schema.String }),
  files: Schema.Array(SourceEntry),
  gitUrl: Schema.String,
});

/** Write a source directory: code at the root and the given files under ui/public/. */
const writeSource = (directory: string, files: ReadonlyArray<PublicFile>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const put = (relative: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const target = path.join(directory, ...relative.split("/"));
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(target, bytes);
      });
    yield* put("index.ts", text(indexSource));
    yield* put("package.json", text(appsManifest.content));
    yield* put("ui/index.html", text(page));
    yield* Effect.forEach(files, (file) => put(`ui/public/${file.path}`, file.bytes), {
      concurrency: 16,
      discard: true,
    });
  });

/** Files under a directory that differ from the expected bytes, by path. */
const mismatchedFiles = (directory: string, files: ReadonlyArray<PublicFile>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const problems: string[] = [];
    for (const file of files) {
      const bytes = yield* fs
        .readFile(path.join(directory, "ui", "public", ...file.path.split("/")))
        .pipe(Effect.orElseSucceed(() => new Uint8Array()));
      if (sha256(bytes) !== sha256(file.bytes)) problems.push(file.path);
    }
    return problems;
  });

/** The real CLI and Git, run as child processes with a personal access token. */
const tools = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner,
    target = yield* Target,
    evidence = yield* Evidence,
    api = yield* Api,
    actors = yield* Actors;
  const key = yield* body(
    Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "Public files",
    }),
  );
  yield* Effect.addFinalizer(() =>
    api
      .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
      .pipe(Effect.ignore),
  );
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-public-files-" });
  const entry = path.resolve("apps/local/server/src/bin.ts");
  const host = targetHosts(target).api;
  const exec = (label: string, command: string, args: readonly string[]) =>
    evidence.step(
      label,
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make(command, args, {
              extendEnv: false,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: home,
                DO_NOT_TRACK: "1",
                GIT_TERMINAL_PROMPT: "0",
                EXECUTOR_ACCESS_TOKEN: Redacted.value(key.key),
              },
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "3 seconds",
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, code };
        }),
      ),
    );
  const cli = (args: readonly string[]) =>
    exec(`executor apps ${args[0]}`, "node", [
      entry,
      "apps",
      ...args,
      "--host",
      host,
      "--organization",
      actors.organization.id,
    ]);
  const git = (args: readonly string[]) =>
    exec(`git ${args[0]}`, "git", [
      "-c",
      `http.extraHeader=Authorization: Bearer ${Redacted.value(key.key)}`,
      ...args,
    ]);
  return { cli, git, home };
});

/** Fetch files from the signed-in app page; compare type and SHA-256 of the exact bytes. */
const servedMismatches = (files: ReadonlyArray<PublicFile>, base: string) =>
  Effect.flatMap(Browser, (browser) =>
    browser.use("Read public files from the app page", (page) =>
      page.evaluate(
        ({ expected, base }) => {
          const hex = (buffer: ArrayBuffer) =>
            Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(
              "",
            );
          const problems: string[] = [];
          let next = 0;
          const check = (file: (typeof expected)[number]): Promise<void> =>
            fetch(`${base}${file.path}`, { cache: "no-store" }).then((response) =>
              response
                .arrayBuffer()
                .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
                .then((digest) => {
                  const type = response.headers.get("content-type")?.split(";")[0];
                  if (
                    response.status !== 200 ||
                    type !== file.contentType ||
                    hex(digest) !== file.sha256
                  )
                    problems.push(
                      `${file.path}: ${response.status} ${type} ${hex(digest) === file.sha256}`,
                    );
                }),
            );
          const worker = (): Promise<void> => {
            const file = expected[next++];
            return file === undefined ? Promise.resolve() : check(file).then(worker);
          };
          return Promise.all(Array.from({ length: 8 }, worker)).then(() => problems);
        },
        {
          expected: files.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            sha256: sha256(file.bytes),
          })),
          base,
        },
      ),
    ),
  );

/** Every binary file, and a spread of the chunks. */
const sample = (files: ReadonlyArray<PublicFile>) =>
  files.filter((file, index) => !file.path.startsWith("assets/chunk-") || index % 25 === 0);

layer(HostedLive, { excludeTestServices: true })("App public files", (it) => {
  it.effect(
    scenarios.appPublicFiles.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const { cli, git, home } = yield* tools;
          const files = publicFiles(randomUUID());
          const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
          expect(total).toBeGreaterThan(16 * 1024 * 1024);
          const directory = path.join(home, "source");
          yield* writeSource(directory, files);

          // The CLI creates the app and deploys the directory; Git carries what one request cannot.
          const created = yield* cli([
            "create",
            "--name",
            `Public files ${randomUUID().slice(0, 8)}`,
            "--files",
            directory,
          ]);
          expect(created.code, created.stderr).toBe(0);
          const app = yield* Schema.decodeUnknownEffect(Created)(created.stdout);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.ignore),
          );
          const deployed = yield* cli(["deploy", "--app", app.id, "--files", directory]);
          expect(deployed.code, deployed.stderr).toBe(0);
          const deployment = (yield* Schema.decodeUnknownEffect(Deployed)(deployed.stdout))
            .deployment.id;

          // Reads list binary and oversized public files by their blob; text stays inline.
          const working = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
          );
          const listed = new Map(working.files.map((file) => [file.path, file]));
          const large = files.find((file) => file.path === "media/large.bin");
          if (large === undefined) return yield* Effect.die(new Error("large file missing"));
          expect(listed.get("ui/public/media/large.bin")).toEqual({
            path: "ui/public/media/large.bin",
            object: blobId(large.bytes),
            size: large.bytes.length,
          });
          expect(listed.get("ui/public/assets/chunk-7.js")).toEqual({
            path: "ui/public/assets/chunk-7.js",
            content: "export const chunk = 7;\n",
          });
          expect(listed.get("index.ts")).toEqual({ path: "index.ts", content: indexSource });

          const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
          yield* browser.login(actors.owner);
          yield* openPrivateApp(url);
          // The prebuilt entry ran: wasm instantiated from its served type, and a chunk loaded.
          yield* browser.use("The prebuilt entry runs", (page) =>
            page.locator('body[data-sum="5"][data-chunk="299"]').waitFor({ state: "attached" }),
          );
          expect(
            yield* browser.use("The relative image loads", (page) =>
              page
                .getByAltText("Pixel")
                .evaluate((image: HTMLImageElement) => (image.complete ? image.naturalWidth : 0)),
            ),
          ).toBe(1);
          expect(yield* servedMismatches(sample(files), "/")).toEqual([]);
          const pinned = `/_executor/assets/${deployment}/`;
          expect(yield* servedMismatches(sample(files).slice(0, 12), pinned)).toEqual([]);

          // Ranges, blob validators and caching.
          const ranges = yield* browser.use("Ranges and validators", (page) =>
            page.evaluate(
              ({ pinned }) => {
                const bytes = (response: Response) =>
                  response.arrayBuffer().then((buffer) => Array.from(new Uint8Array(buffer)));
                return Promise.all([
                  fetch("/media/large.bin", { headers: { range: "bytes=100-199" } }),
                  fetch("/media/large.bin", { headers: { range: "bytes=-10" } }),
                  fetch("/audio/chime.mp3", { headers: { range: "bytes=999999999-" } }),
                  fetch(`${pinned}wasm/add.wasm`, { cache: "no-store" }),
                  fetch("/wasm/add.wasm", { cache: "no-store" }),
                ]).then(([range, tail, beyond, fixed, root]) => {
                  const etag = range.headers.get("etag") ?? "";
                  return Promise.all([
                    bytes(range),
                    bytes(tail),
                    fetch("/media/large.bin", {
                      cache: "no-store",
                      headers: { "if-none-match": etag },
                    }),
                  ]).then(([ranged, ending, revalidated]) => ({
                    status: range.status,
                    contentRange: range.headers.get("content-range"),
                    bytes: ranged,
                    etag,
                    revalidated: revalidated.status,
                    tail: ending,
                    beyond: beyond.status,
                    fixedCache: fixed.headers.get("cache-control"),
                    rootCache: root.headers.get("cache-control"),
                    nosniff: root.headers.get("x-content-type-options"),
                  }));
                });
              },
              { pinned },
            ),
          );
          expect(ranges.status).toBe(206);
          expect(ranges.contentRange).toBe(`bytes 100-199/${large.bytes.length}`);
          expect(ranges.bytes).toEqual(Array.from(large.bytes.slice(100, 200)));
          expect(ranges.etag).toBe(`"${blobId(large.bytes)}"`);
          expect(ranges.revalidated).toBe(304);
          expect(ranges.tail).toEqual(Array.from(large.bytes.slice(-10)));
          expect(ranges.beyond).toBe(416);
          expect(ranges.fixedCache).toBe("private, max-age=31536000, immutable");
          expect(ranges.rootCache).toBe("private, no-cache");
          expect(ranges.nosniff).toBe("nosniff");

          // Public files need the app session, like every app route.
          const http = yield* HttpClient.HttpClient;
          const anonymous = yield* HttpClientRequest.get(new URL("/wasm/add.wasm", url).href).pipe(
            http.execute,
            Effect.map((response) => response.status),
            Effect.scoped,
          );
          expect(anonymous).toBe(403);

          // Source is complete: the CLI and a Git clone both return every byte.
          const written = path.join(home, "written");
          const source = yield* cli(["source", "--app", app.id, "--out", written]);
          expect(source.code, source.stderr).toBe(0);
          expect(yield* mismatchedFiles(written, files)).toEqual([]);
          const cloned = path.join(home, "cloned");
          const clone = yield* git(["clone", "--quiet", working.gitUrl, cloned]);
          expect(clone.code, clone.stderr).toBe(0);
          expect(yield* mismatchedFiles(cloned, files)).toEqual([]);
          expect(yield* fs.readFileString(path.join(cloned, "index.ts"))).toBe(indexSource);

          // A copy is an ordinary app with its own source and its own copy of the files.
          const copied = yield* api.request(actors.owner, "POST", `${prefix}/apps/copies`, {
            from: { app: app.id },
            name: `Public files copy ${randomUUID().slice(0, 8)}`,
          });
          expect(copied.status, JSON.stringify(copied.body)).toBe(200);
          const copy = yield* body(App, copied);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${copy.id}`).pipe(Effect.ignore),
          );
          const copyUrl = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${copy.id}/ui`);
          yield* openPrivateApp(copyUrl);
          yield* browser.use("The copy's prebuilt entry runs", (page) =>
            page.locator('body[data-sum="5"]').waitFor({ state: "attached" }),
          );
          expect(yield* servedMismatches(sample(files).slice(0, 12), "/")).toEqual([]);
          // Removing the original leaves the copy's files in place.
          const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
          expect(removed.status).toBe(200);
          expect(yield* servedMismatches([large], "/")).toEqual([]);
        }),
      ),
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.appPublicFilesRollback.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const slug = `public-files-${randomUUID().slice(0, 8)}`;
          const name = `@${actors.organization.slug}.executor.community/${slug}`;
          const versioned = (version: string, extra: ReadonlyArray<PublicFile>): PublicFile[] => [
            {
              path: "assets/main.js",
              bytes: text(`document.body.dataset.version = ${JSON.stringify(version)};\n`),
              contentType: "text/javascript",
            },
            {
              path: "media/data.bin",
              bytes: binary(version, 300_000),
              contentType: "application/octet-stream",
            },
            ...extra,
          ];
          // Small binary files travel through the API as base64, beside the code.
          const sourceFiles = (files: ReadonlyArray<PublicFile>) => [
            { path: "index.ts", content: indexSource },
            {
              path: "package.json",
              content: JSON.stringify({ name, dependencies: withApps() }),
            },
            {
              path: "ui/index.html",
              content: `<!doctype html><html><head><script type="module" src="/assets/main.js"></script></head><body></body></html>`,
            },
            ...files.map((file) =>
              file.contentType === "text/javascript"
                ? { path: `ui/public/${file.path}`, content: new TextDecoder().decode(file.bytes) }
                : {
                    path: `ui/public/${file.path}`,
                    content: Buffer.from(file.bytes).toString("base64"),
                    encoding: "base64",
                  },
            ),
          ];
          const first = versioned("first", []);
          const added: PublicFile = {
            path: "media/added.bin",
            bytes: binary("ADDED", 1000),
            contentType: "application/octet-stream",
          };
          const second = versioned("second", [added]);
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Public rollback ${slug}`,
            files: sourceFiles(first),
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.ignore),
          );
          const original = app.activeDeployment;
          const redeployed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/deploy`,
            { files: sourceFiles(second) },
          );
          expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
          const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
          yield* browser.login(actors.owner);
          yield* openPrivateApp(url);
          yield* browser.use("The second deployment runs", (page) =>
            page.locator('body[data-version="second"]').waitFor({ state: "attached" }),
          );
          expect(yield* servedMismatches(second, "/")).toEqual([]);
          // The first deployment's files stay at its own pinned URLs while the second is active.
          expect(yield* servedMismatches(first, `/_executor/assets/${original}/`)).toEqual([]);

          const current = yield* body(
            App,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}`),
          );
          const activated = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/activate`,
            { deployment: original, expectedDeployment: current.activeDeployment },
          );
          expect(activated.status).toBe(200);
          // Activation reloads open pages; the reloaded page runs the first deployment's entry.
          yield* browser.use("The first deployment runs again", (page) =>
            page.locator('body[data-version="first"]').waitFor({ state: "attached" }),
          );
          expect(yield* servedMismatches(first, "/")).toEqual([]);
          const gone = yield* browser.use("A file only the second deployment had", (page) =>
            page.evaluate(() =>
              fetch("/media/added.bin", { cache: "no-store" }).then((response) => response.status),
            ),
          );
          expect(gone).toBe(404);

          // A published commit carries its binary files; an install serves its own copy of them.
          const working = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
          );
          const committed = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/commits`,
            { expected: working.revision.commit, files: sourceFiles(second), message: "Second" },
          );
          expect(committed.status, JSON.stringify(committed.body)).toBe(200);
          const head = yield* body(
            Workspace,
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/workspace`),
          );
          // Binary files of a read keep their blob, so sending the read back changes nothing.
          expect(head.files.find((file) => file.path === "ui/public/media/added.bin")).toEqual({
            path: "ui/public/media/added.bin",
            object: blobId(added.bytes),
            size: added.bytes.length,
          });
          // Self-host reads the hosted catalog and does not publish; Cloud keeps its own.
          if ((yield* Target).metadata.target !== "cloud") return;
          const published = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${app.id}/publication`,
            { commit: head.revision.commit },
          );
          expect(published.status, JSON.stringify(published.body)).toBe(200);
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.owner, "POST", `${prefix}/app-publications/unpublish`, {
                package: name,
              })
              .pipe(Effect.ignore),
          );
          const installed = yield* api.request(actors.owner, "POST", `${prefix}/apps/copies`, {
            from: { package: name, commit: head.revision.commit },
            name: `Public install ${slug}`,
          });
          expect(installed.status, JSON.stringify(installed.body)).toBe(200);
          const install = yield* body(App, installed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${install.id}`).pipe(Effect.ignore),
          );
          const installUrl = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${install.id}/ui`);
          yield* openPrivateApp(installUrl);
          yield* browser.use("The install runs", (page) =>
            page.locator('body[data-version="second"]').waitFor({ state: "attached" }),
          );
          expect(yield* servedMismatches(second, "/")).toEqual([]);
        }),
      ),
    { timeout: 180_000 },
  );
});
