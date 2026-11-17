/**
 * `scripts/releases/apps-published.ts` refuses to ship a host whose `apps` release npm does not
 * serve exactly as this checkout builds it. These cases run it as a process, the way the deploy
 * and the `check` job do, against a local registry that replays what npm serves right after a
 * publish: the version is listed while its archive still answers 404. Run `bun run apps:build`
 * first; the cases pack the staged package as the archive the registry serves.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const staged = "packages/apps/dist";
const Manifest = Schema.Struct({ version: Schema.String });
const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));

const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

type Flag = "" | "--allow-unpublished" | "--await" | "--publish";

/** One answer of the registry for the archive URL. */
type Archive = { readonly status: number; readonly bytes?: Uint8Array };

/** Pack `directory` with npm, as the script packs the staged package. */
const pack = (directory: string, destination: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fs.makeDirectory(destination, { recursive: true });
    const packed = yield* processes
      .string(
        ChildProcess.make(
          "npm",
          ["pack", directory, "--json", "--ignore-scripts", "--pack-destination", destination],
          { stdout: "pipe", stderr: "ignore" },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    return yield* fs.readFile(path.join(destination, packed[0].filename));
  });

/**
 * The staged package's version and archive, and an archive of the same version whose README
 * differs: a release published from other content.
 */
const archives = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-published-" });
  const { version } = yield* fs
    .readFileString(path.join(staged, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
  const local = yield* pack(staged, path.join(directory, "local"));
  const other = path.join(directory, "other");
  yield* fs.copy(staged, other);
  yield* fs.writeFileString(
    path.join(other, "README.md"),
    `${yield* fs.readFileString(path.join(other, "README.md"))}\nChanged.\n`,
  );
  return { version, local, different: yield* pack(other, path.join(directory, "packed-other")) };
});

/**
 * A registry that lists `version` with `integrity` and answers the archive like npm.
 *
 * `archive` is either the origin's answers in order, repeating the last, or `stored`: 404 until
 * `afterMs` after the first archive request, then the archive. A request for the archive's own
 * URL that gets a 404 is cached for `cachedMs` when given, as npm's CDN does for five minutes: the
 * own URL then answers 404 without asking the origin. A request with a query string is a separate
 * cache entry, so it always reaches the origin. It counts all requests, probes (with a query
 * string) and requests for the archive's own URL, and those of them that got a 404.
 */
const registry = (
  version: string,
  integrity: string,
  archive:
    | ReadonlyArray<Archive>
    | { readonly stored: { readonly afterMs: number; readonly bytes: Uint8Array } },
  options: {
    readonly cachedMs?: number;
    /** The archive's own URL answers 404 for this many requests while fresh URLs reach the origin. */
    readonly ownMissing?: number;
    /** The archive's own URL serves these bytes instead of the origin's. */
    readonly ownBytes?: Uint8Array;
    /** The tarball URL the version's metadata advertises, instead of the registry's own. */
    readonly tarball?: string;
    /** The archive's own URL answers this redirect instead of an archive. */
    readonly redirect?: string;
  } = {},
) => {
  let requests = 0;
  let originRequests = 0;
  let probes = 0;
  let ownRequests = 0;
  let own404 = 0;
  let firstArchiveRequest: number | undefined;
  let cachedUntil = 0;
  const tarball = `/apps/-/apps-${version}.tgz`;
  const origin = (): Archive => {
    if (Array.isArray(archive)) return archive[Math.min(originRequests, archive.length - 1)]!;
    const { stored } = archive as { readonly stored: { afterMs: number; bytes: Uint8Array } };
    return Date.now() - (firstArchiveRequest ?? Date.now()) >= stored.afterMs
      ? { status: 200, bytes: stored.bytes }
      : { status: 404 };
  };
  const server = createServer((request, response) => {
    requests += 1;
    const { port } = server.address() as AddressInfo;
    const url = new URL(request.url ?? "/", "http://registry.invalid");
    if (url.pathname === `/apps/${version}` && url.search === "") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version,
          dist: {
            tarball: options.tarball ?? `http://127.0.0.1:${port}${tarball}`,
            integrity,
          },
        }),
      );
      return;
    }
    if (url.pathname === tarball) {
      if (options.redirect !== undefined) {
        response.writeHead(302, { location: options.redirect });
        response.end();
        return;
      }
      firstArchiveRequest ??= Date.now();
      const own = url.search === "";
      if (own) ownRequests += 1;
      else probes += 1;
      const cached = own && (Date.now() < cachedUntil || ownRequests <= (options.ownMissing ?? 0));
      const fromOrigin = cached ? { status: 404 } : origin();
      if (!cached) originRequests += 1;
      const answer: Archive =
        own && !cached && fromOrigin.status === 200 && options.ownBytes !== undefined
          ? { status: 200, bytes: options.ownBytes }
          : fromOrigin;
      if (own && answer.status === 404) {
        own404 += 1;
        if (options.cachedMs !== undefined && Date.now() >= cachedUntil)
          cachedUntil = Date.now() + options.cachedMs;
      }
      response.writeHead(answer.status, { "content-type": "application/octet-stream" });
      response.end(answer.bytes ?? "");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.as({
      url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests: () => requests,
      probes: () => probes,
      ownRequests: () => ownRequests,
      own404: () => own404,
    }),
  );
};

/**
 * A second origin that serves `bytes` at every path and counts requests. The gate must never
 * ask it for an SDK the builder registry advertises elsewhere.
 */
const otherOrigin = (bytes: Uint8Array) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(bytes);
  });
  return Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.as({
      url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests: () => requests,
    }),
  );
};

/**
 * Run the check with `flag` against `url` and return its exit code and combined output. The
 * release check passes no flag; the production deploy's flags refuse another registry.
 */
const check = (
  url: string,
  flag: Flag,
  env: Readonly<Record<string, string>> = {},
  selfHost = false,
  packageDirectory?: string,
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(
        "node",
        [
          selfHost ? "scripts/releases/apps-self-host.ts" : "scripts/releases/apps-published.ts",
          ...(flag ? [flag] : []),
          ...(packageDirectory ? ["--package", packageDirectory] : []),
        ],
        {
          env: { APPS_REGISTRY: url, EXECUTOR_NPM_REGISTRY: url, ...env },
          extendEnv: true,
        },
      ),
    );
    // The runtime logs a failure to stdout, so the cases read both streams together.
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("apps release check", (it) => {
  it.effect("self-host gate requires the builder registry's exact SDK content", () =>
    Effect.gen(function* () {
      const { version, local, different } = yield* archives;
      for (const [bytes, succeeds] of [
        [local, true],
        [different, false],
      ] as const) {
        const npm = yield* registry(version, integrityOf(bytes), [{ status: 200, bytes }]);
        const run = yield* check(npm.url(), "", {}, true);
        expect(run.exitCode, run.log).toBe(succeeds ? 0 : 1);
        expect(run.log).toContain(
          succeeds
            ? `Builder registry serves matching apps@${version}`
            : "Builder SDK content differs",
        );
        if (!succeeds) expect(run.log).toContain("README.md");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("self-host gate refuses an SDK tarball or redirect on another origin", () =>
    Effect.gen(function* () {
      const { version, local } = yield* archives;
      const integrity = integrityOf(local);
      const outside = yield* otherOrigin(local);
      for (const options of [
        { tarball: `${outside.url()}/apps-${version}.tgz` },
        { redirect: `${outside.url()}/apps-${version}.tgz` },
      ] as const) {
        const npm = yield* registry(version, integrity, [{ status: 200, bytes: local }], options);
        const run = yield* check(npm.url(), "", {}, true);
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain("outside the builder registry's origin");
        expect(run.log).toContain(npm.url());
        expect(run.log).toContain(outside.url());
      }
      // The gate refuses before it asks the other origin for the archive.
      expect(outside.requests()).toBe(0);
      const same = yield* registry(version, integrity, [{ status: 200, bytes: local }]);
      const pass = yield* check(same.url(), "", {}, true);
      expect(pass.exitCode, pass.log).toBe(0);
      expect(pass.log).toContain(`Builder registry serves matching apps@${version}`);
    }).pipe(Effect.scoped),
  );

  it.effect("self-host gate refuses missing archives and corrupt registry integrity", () =>
    Effect.gen(function* () {
      const { version, local, different } = yield* archives;
      for (const [status, bytes, message] of [
        [404, local, "Builder SDK tarball is unavailable"],
        [200, different, "Builder SDK tarball integrity differs"],
      ] as const) {
        const npm = yield* registry(version, integrityOf(local), [{ status, bytes }]);
        const run = yield* check(npm.url(), "", {}, true);
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain(message);
      }
      const missing = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          missing.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.callback<void>((resume) => {
            missing.close(() => resume(Effect.void));
          }),
      );
      const run = yield* check(
        `http://127.0.0.1:${(missing.address() as AddressInfo).port}`,
        "",
        {},
        true,
      );
      expect(run.exitCode, run.log).toBe(1);
      expect(run.log).toContain("Deployment refused");
    }).pipe(Effect.scoped),
  );

  it.effect("self-host private publication preserves a historical SDK and never republishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const historical = path.join(directory, "historical");
      yield* fs.copy(staged, historical);
      yield* fs.writeFileString(
        path.join(historical, "check-publish.mjs"),
        'throw new Error("Historical directory publication refused");\n',
      );
      const { version } = yield* fs
        .readFileString(path.join(historical, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
      let puts = 0;
      let bytes: Uint8Array | undefined;
      let integrity = "";
      const server = createServer((request, response) => {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        if (request.method === "PUT" && request.url === "/apps") {
          puts += 1;
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body = Buffer.concat(chunks);
            const metadata = JSON.parse(body.toString());
            const attachment = Object.values(metadata._attachments)[0] as { data: string };
            bytes = Buffer.from(attachment.data, "base64");
            integrity = integrityOf(bytes);
            response.writeHead(201, { "content-type": "application/json" });
            response.end("{}");
          });
        } else if (request.url === `/apps/${version}` && bytes) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ version, dist: { tarball: `${url}/archive.tgz`, integrity } }),
          );
        } else if (request.url === "/archive.tgz" && bytes) {
          response.writeHead(200);
          response.end(bytes);
        } else {
          response.writeHead(404);
          response.end("{}");
        }
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const npmrc = path.join(directory, "npmrc");
      yield* fs.writeFileString(
        npmrc,
        `//127.0.0.1:${(server.address() as AddressInfo).port}/:_authToken=synthetic-e2e-token\n`,
      );
      const env = { NPM_CONFIG_USERCONFIG: npmrc };
      const before = yield* check(url, "", env, true, historical);
      expect(before.exitCode).toBe(1);
      expect(before.log).toContain("Deployment refused");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const run = yield* check(url, "--publish", env, true, historical);
        expect(run.exitCode, run.log).toBe(0);
        expect(run.log).toContain(`Builder registry serves matching apps@${version}`);
      }
      expect(puts).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("private fork publish policy runs through npm and refuses public destinations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped();
      const hook = yield* fs.readFileString("packages/apps/scripts/check-publish.mjs");
      yield* fs.writeFileString(path.join(directory, "check-publish.mjs"), hook);
      for (const [version, registry, configured, tag, succeeds] of [
        ["0.0.1-beta.138.shuv.1", "http://127.0.0.1:4873", "http://127.0.0.1:4873/", "beta", true],
        [
          "0.0.1-beta.138.shuv.1",
          "https://registry.npmjs.org",
          "https://registry.npmjs.org",
          "beta",
          false,
        ],
        [
          "0.0.1-beta.138.shuv.1",
          "https://registry.npmjs.org",
          "http://127.0.0.1:4873",
          "beta",
          false,
        ],
        ["0.0.1-beta.138.shuv.1", "http://127.0.0.1:4873", "", "beta", false],
        ["0.0.1-beta.138.shuv.1", "http://127.0.0.1:4873", "http://127.0.0.1:4874", "beta", false],
        ["0.0.1-beta.138", "https://registry.npmjs.org", "", "beta", true],
        ["0.0.1", "http://127.0.0.1:4873", "http://127.0.0.1:4873", "beta", false],
        ["0.0.1-beta.138.other.1", "http://127.0.0.1:4873", "http://127.0.0.1:4873", "beta", false],
      ] as const) {
        yield* fs.writeFileString(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: "apps",
            version,
            files: ["check-publish.mjs"],
            scripts: { prepublishOnly: "node check-publish.mjs" },
            publishConfig: { tag: "beta" },
          }),
        );
        const child = yield* processes.spawn(
          ChildProcess.make(
            "npm",
            ["publish", directory, "--dry-run", "--offline", "--registry", registry, "--tag", tag],
            { env: { EXECUTOR_NPM_REGISTRY: configured }, extendEnv: true },
          ),
        );
        const [log, exitCode] = yield* Effect.all(
          [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" },
        );
        expect(log).toContain("node check-publish.mjs");
        expect(exitCode, `${version} ${registry} ${configured} ${tag}\n${log}`).toBe(
          succeeds ? 0 : 1,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the release and pull request checks wait while npm lists a release before serving its archive",
    () =>
      Effect.gen(function* () {
        const { version, local } = yield* archives;
        // npm's CDN answered 404 for the archive of apps@0.0.1-beta.39 for seconds after listing it.
        const answers = [{ status: 404 }, { status: 404 }, { status: 200, bytes: local }];
        const runs = yield* Effect.forEach(
          ["", "--allow-unpublished"] as const,
          (flag) =>
            Effect.gen(function* () {
              const npm = yield* registry(version, integrityOf(local), answers);
              return {
                flag,
                run: yield* check(npm.url(), flag),
                probes: npm.probes(),
                own: npm.ownRequests(),
              };
            }),
          { concurrency: "unbounded" },
        );
        for (const { flag, run, probes, own } of runs) {
          expect(run.log, flag).toContain(
            `Waiting for npm to serve the archive of apps@${version}`,
          );
          expect(run.log, flag).toContain(`apps@${version} is published on npm and matches`);
          expect(run.exitCode, flag).toBe(0);
          // The archive's own URL is asked once, after a fresh URL showed npm serves it.
          expect(probes, flag).toBe(3);
          expect(own, flag).toBe(1);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a 404 npm's CDN caches for the archive's own URL never holds the check or app builds",
    () =>
      Effect.gen(function* () {
        const { version, local } = yield* archives;
        // npm listed apps@0.0.1-beta.135 before it stored the archive, and the deploy's request
        // for the archive at that moment was cached as a 404 for five minutes (300 s). Here npm
        // stores it 2 s after the first archive request, and caches a 404 for 60 s.
        const npm = yield* registry(
          version,
          integrityOf(local),
          { stored: { afterMs: 2_000, bytes: local } },
          { cachedMs: 60_000 },
        );
        const started = Date.now();
        const run = yield* check(npm.url(), "");
        const seconds = (Date.now() - started) / 1000;
        expect(run.exitCode, run.log).toBe(0);
        expect(run.log).toContain(`apps@${version} is published on npm and matches`);
        // No request for the archive's own URL, which app builds read, got a 404 to cache.
        expect(npm.own404()).toBe(0);
        expect(npm.ownRequests()).toBe(1);
        // One wait between attempts (10 s), not the cached 404's 60 s.
        expect(seconds).toBeLessThan(30);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "an archive npm serves under a fresh URL but not its own is retried, and fails if it stays so",
    () =>
      Effect.gen(function* () {
        const { version, local } = yield* archives;
        const missing = yield* registry(
          version,
          integrityOf(local),
          [{ status: 200, bytes: local }],
          { ownMissing: Number.POSITIVE_INFINITY },
        );
        // Two retries instead of 42, so the test reaches the end of the wait.
        const run = yield* check(missing.url(), "", { APPS_ARCHIVE_ATTEMPTS: "2" });
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain(
          `npm lists apps@${version} but still answers 404 for its archive`,
        );
        expect(missing.probes()).toBe(3);
        expect(missing.ownRequests()).toBe(3);
        expect(missing.own404()).toBe(3);

        const late = yield* registry(version, integrityOf(local), [{ status: 200, bytes: local }], {
          ownMissing: 1,
        });
        const passed = yield* check(late.url(), "");
        expect(passed.exitCode, passed.log).toBe(0);
        expect(passed.log).toContain(`Waiting for npm to serve the archive of apps@${version}`);
        expect(late.ownRequests()).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.effect("the check compares the archive's own URL, never what a fresh URL served", () =>
    Effect.gen(function* () {
      const { version, local, different } = yield* archives;
      // The fresh URL serves this build's archive; the URL app builds read serves other content.
      const npm = yield* registry(version, integrityOf(local), [{ status: 200, bytes: local }], {
        ownBytes: different,
      });
      const run = yield* check(npm.url(), "");
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        `The npm archive of apps@${version} has integrity ${integrityOf(different)}, not its registry integrity ${integrityOf(local)}.`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an archive whose integrity differs from the registry's fails without waiting", () =>
    Effect.gen(function* () {
      const { version, local, different } = yield* archives;
      const npm = yield* registry(version, integrityOf(local), [{ status: 200, bytes: different }]);
      const run = yield* check(npm.url(), "");
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        `The npm archive of apps@${version} has integrity ${integrityOf(different)}, not its registry integrity ${integrityOf(local)}.`,
      );
      expect(run.log).not.toContain("Waiting for npm to serve the archive");
      expect(npm.probes()).toBe(1);
      expect(npm.ownRequests()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a release npm consistently serves with other content fails", () =>
    Effect.gen(function* () {
      const { version, different } = yield* archives;
      const runs = yield* Effect.forEach(
        ["", "--allow-unpublished"] as const,
        (flag) =>
          Effect.gen(function* () {
            const npm = yield* registry(version, integrityOf(different), [
              { status: 404 },
              { status: 200, bytes: different },
            ]);
            return { flag, run: yield* check(npm.url(), flag) };
          }),
        { concurrency: "unbounded" },
      );
      for (const { flag, run } of runs) {
        expect(run.exitCode, flag).toBe(1);
        expect(run.log, flag).toContain(
          `packages/apps changed since apps@${version} was published; bump the version`,
        );
        expect(run.log, flag).toContain("README.md");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("an archive answer other than 404 fails without waiting", () =>
    Effect.gen(function* () {
      const { version, local } = yield* archives;
      const npm = yield* registry(version, integrityOf(local), [{ status: 500 }]);
      const run = yield* check(npm.url(), "");
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(`for apps@${version} with status 500.`);
      expect(npm.probes()).toBe(1);
      expect(npm.ownRequests()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("the production deploy refuses another registry before any request", () =>
    Effect.gen(function* () {
      const { version, local } = yield* archives;
      const runs = yield* Effect.forEach(
        ["--publish", "--await"] as const,
        (flag) =>
          Effect.gen(function* () {
            const npm = yield* registry(version, integrityOf(local), [
              { status: 200, bytes: local },
            ]);
            const run = yield* check(npm.url(), flag);
            return { flag, url: npm.url(), run, requests: npm.requests() };
          }),
        { concurrency: "unbounded" },
      );
      for (const { flag, url, run, requests } of runs) {
        expect(run.exitCode, flag).toBe(1);
        expect(run.log, flag).toContain(
          `--publish and --await check only https://registry.npmjs.org, not APPS_REGISTRY ${url}.`,
        );
        expect(requests, flag).toBe(0);
      }
    }).pipe(Effect.scoped),
  );
});
