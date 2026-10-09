/**
 * Refuse to ship a host whose `apps` release is not on npm exactly as this checkout builds it.
 * New apps pin the version in `packages/apps/package.json`. A host shipping an unpublished version
 * cannot build them, and a host whose framework changed after that version was published pins
 * new apps to code other than its own.
 *
 * Run `bun run apps:build` first. The staged package is packed as npm would publish it, and every
 * file is compared byte for byte with the published archive.
 *
 * Modes:
 * - no flag: the version must be on npm with identical content (release publication).
 * - `--publish`: the deploy from `main` publishes an unpublished version with `NPM_TOKEN`, waits
 *   until the registry serves it with the local archive's integrity, then compares as above. A
 *   version already on npm is only compared, so rerunning a deploy is idempotent.
 * - `--allow-unpublished`: pull requests only warn about an unpublished bump, because merging to
 *   `main` publishes it. A published version whose content differs still fails.
 * - `--await`: the production deploy runs beside the job that publishes. It waits for the registry
 *   to serve the version, then compares as above. It never publishes.
 *
 * npm lists a new version a few seconds before it serves the version's archive, and its CDN keeps
 * serving the archive's 404 for up to five minutes (`cache-control: max-age=300`). Every mode
 * waits, for a bounded time, while the listed archive is missing. Any other status, or an archive
 * whose integrity differs from the registry's, fails at once.
 *
 * `APPS_REGISTRY` points the checks at another registry; e2e/tests/apps-published.spec.ts uses it
 * to replay npm's propagation. The production deploy's modes, `--publish` and `--await`, refuse it
 * before any request, so a stray override cannot let a deploy pass without npm.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Path, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import apps from "../../packages/apps/package.json" with { type: "json" };
import {
  AppsReleaseMismatch,
  differingFiles,
  integrityOf,
  listFiles,
  pack,
  staged,
  stagedVersion,
  unpack,
} from "./apps-package.ts";

const npm = "https://registry.npmjs.org";
const allowUnpublished = process.argv.includes("--allow-unpublished");
const publish = process.argv.includes("--publish");
const awaitPublication = process.argv.includes("--await");
const Published = Schema.Struct({
  version: Schema.String,
  dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.String }),
});
const Tags = Schema.Record(Schema.String, Schema.String);

/**
 * Seven minutes of waits between attempts cover the CDN's five-minute 404 for an archive npm did
 * not yet store. Request time comes on top; this is not a deadline.
 */
const archiveWait = Schedule.spaced(10_000);
const archiveAttempts = 42;

class NotServed extends Schema.TaggedError<NotServed>()("NotServed", {
  status: Schema.Number,
}) {}

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;
    const version = apps.version;
    const registry = yield* Config.String("APPS_REGISTRY").pipe(Config.withDefault(npm));
    if (registry !== npm && (publish || awaitPublication))
      return yield* new AppsReleaseMismatch({
        message: `--publish and --await check only ${npm}, not APPS_REGISTRY ${registry}.`,
      });

    const built = yield* stagedVersion(staged);
    if (built !== version)
      return yield* new AppsReleaseMismatch({
        message: `${staged} holds apps@${built}, not ${version}; run bun run apps:build again.`,
      });

    const directory = yield* fs.makeTempDirectoryScoped();
    const local = yield* pack(staged, path.join(directory, "local"));
    const lookup = Effect.gen(function* () {
      const response = yield* http.get(`${registry}/apps/${version}`);
      if (response.status !== 200) {
        yield* response.text;
        return yield* new NotServed({ status: response.status });
      }
      return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Published)));
    });
    const tags = http.get(`${registry}/-/package/apps/dist-tags`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Tags)),
    );

    const existing = yield* (
      awaitPublication
        ? lookup.pipe(
            Effect.timeout(15_000),
            Effect.tapError(() => Console.log(`Waiting for npm to serve apps@${version}`)),
            Effect.retry({ schedule: Schedule.spaced(10_000), times: 60 }),
          )
        : lookup
    ).pipe(
      Effect.map((published) => ({ published })),
      Effect.catchTag("NotServed", (missing) => Effect.succeed({ missing })),
    );
    const unpublished = (status: number) =>
      `apps@${version} is not published on npm (status ${status}). The deploy from main publishes it; see notes/apps-publishing.md.`;
    if ("missing" in existing && allowUnpublished)
      return yield* Console.log(`::warning::${unpublished(existing.missing.status)}`);

    const publishNew = (status: number) =>
      Effect.gen(function* () {
        if (!publish || status !== 404)
          return yield* new AppsReleaseMismatch({ message: unpublished(status) });
        const token = yield* Config.Redacted("NPM_TOKEN");
        const before = yield* tags;
        const npmrc = path.join(directory, "npmrc");
        // npm substitutes the explicitly supplied environment variable. The file contains no secret.
        yield* fs.writeFileString(npmrc, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n", {
          mode: 0o600,
        });
        // Publishing the directory runs the staged package's own hook, which rejects non-beta releases.
        const code = yield* processes.exitCode(
          ChildProcess.make("npm", ["publish", staged, "--tag", "beta", "--access", "public"], {
            env: { NPM_CONFIG_USERCONFIG: npmrc, NPM_TOKEN: Redacted.value(token) },
            extendEnv: true,
            stdout: "inherit",
            stderr: "inherit",
          }),
        );
        if (code !== 0)
          return yield* new AppsReleaseMismatch({
            message: `npm publish apps@${version} failed. Inspect the registry; once it serves apps@${version}, rerunning compares it instead of publishing again.`,
          });
        const served = yield* lookup.pipe(
          Effect.timeout(15_000),
          Effect.retry({ schedule: Schedule.spaced(10_000), times: 90 }),
        );
        if (served.dist.integrity !== local.integrity)
          return yield* new AppsReleaseMismatch({
            message: `The registry serves apps@${version} with integrity ${served.dist.integrity}, not the local archive's ${local.integrity}.`,
          });
        const after = yield* tags.pipe(
          Effect.filterOrFail(
            (current) => current.beta === version,
            () => new NotServed({ status: 200 }),
          ),
          Effect.timeout(15_000),
          Effect.retry({ schedule: Schedule.spaced(10_000), times: 30 }),
        );
        if (after.latest !== before.latest)
          return yield* new AppsReleaseMismatch({
            message: `Publishing apps@${version} moved latest from ${before.latest} to ${after.latest}. Restore it by hand.`,
          });
        yield* Console.log(`Published apps@${version} with --tag beta; latest=${after.latest}`);
        return served;
      });
    const published =
      "published" in existing ? existing.published : yield* publishNew(existing.missing.status);

    const download = Effect.gen(function* () {
      const archive = yield* http.get(published.dist.tarball);
      if (archive.status === 404) {
        yield* archive.text;
        return yield* new NotServed({ status: archive.status });
      }
      if (archive.status !== 200)
        return yield* new AppsReleaseMismatch({
          message: `npm answered ${published.dist.tarball} for apps@${version} with status ${archive.status}.`,
        });
      return new Uint8Array(yield* archive.arrayBuffer);
    });
    const bytes = yield* download.pipe(
      Effect.tapError((error) =>
        error._tag === "NotServed"
          ? Console.log(`Waiting for npm to serve the archive of apps@${version}`)
          : Effect.void,
      ),
      Effect.retry({
        while: (error) => error._tag === "NotServed",
        schedule: archiveWait,
        times: archiveAttempts,
      }),
      Effect.catchTag("NotServed", () =>
        Effect.fail(
          new AppsReleaseMismatch({
            message: `npm lists apps@${version} but still answers 404 for its archive ${published.dist.tarball}.`,
          }),
        ),
      ),
    );
    const archiveIntegrity = integrityOf(bytes);
    if (archiveIntegrity !== published.dist.integrity)
      return yield* new AppsReleaseMismatch({
        message: `The npm archive of apps@${version} has integrity ${archiveIntegrity}, not its registry integrity ${published.dist.integrity}.`,
      });
    const remoteArchive = path.join(directory, "published.tgz");
    yield* fs.writeFile(remoteArchive, bytes);
    const differing = yield* differingFiles(
      yield* unpack(local.archive, path.join(directory, "staged")),
      yield* unpack(remoteArchive, path.join(directory, "published")),
    );
    if (differing.length > 0)
      return yield* new AppsReleaseMismatch({
        message: `packages/apps changed since apps@${version} was published; bump the version in packages/apps/package.json. See notes/apps-publishing.md. ${listFiles(differing)}`,
      });
    yield* Effect.log(`apps@${version} is published on npm and matches ${staged}.`);
  }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
