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
 * A registry that lists `version` with `integrity` and answers the archive URL with `archive` in
 * order, repeating the last answer. It counts all requests and the archive requests.
 */
const registry = (version: string, integrity: string, archive: ReadonlyArray<Archive>) => {
  let requests = 0;
  let archiveRequests = 0;
  const tarball = `/apps/-/apps-${version}.tgz`;
  const server = createServer((request, response) => {
    requests += 1;
    const { port } = server.address() as AddressInfo;
    if (request.url === `/apps/${version}`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          version,
          dist: { tarball: `http://127.0.0.1:${port}${tarball}`, integrity },
        }),
      );
      return;
    }
    if (request.url === tarball) {
      const answer = archive[Math.min(archiveRequests, archive.length - 1)]!;
      archiveRequests += 1;
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
      archiveRequests: () => archiveRequests,
    }),
  );
};

/**
 * Run the check with `flag` against `url` and return its exit code and combined output. The
 * release check passes no flag; the production deploy's flags refuse another registry.
 */
const check = (url: string, flag: Flag) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/releases/apps-published.ts", ...(flag ? [flag] : [])], {
        env: { APPS_REGISTRY: url },
        extendEnv: true,
      }),
    );
    // The runtime logs a failure to stdout, so the cases read both streams together.
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("apps release check", (it) => {
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
              return { flag, run: yield* check(npm.url(), flag), requests: npm.archiveRequests() };
            }),
          { concurrency: "unbounded" },
        );
        for (const { flag, run, requests } of runs) {
          expect(run.log, flag).toContain(
            `Waiting for npm to serve the archive of apps@${version}`,
          );
          expect(run.log, flag).toContain(`apps@${version} is published on npm and matches`);
          expect(run.exitCode, flag).toBe(0);
          expect(requests, flag).toBe(3);
        }
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
      expect(npm.archiveRequests()).toBe(1);
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
      expect(npm.archiveRequests()).toBe(1);
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
