/**
 * Fail a pull request that changes the `apps` package without moving its version past the base's.
 * Merging to `main` allocates the version and the deploy publishes it, so two different packages
 * must never carry the same version, even before either is on npm. The version must also be
 * greater, not only different: a lower number can be one a deploy never published (Deploy runs
 * only the newest pending commit), and taking it would move the `beta` tag backwards.
 *
 * Usage: `node scripts/releases/apps-bumped.ts <base staged directory>` after `bun run apps:build`
 * in both this checkout and the base checkout. Both are packed without scripts and compared file
 * by file; npm packs the same tree identically in any checkout.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import {
  AppsReleaseMismatch,
  differingFiles,
  listFiles,
  pack,
  staged,
  stagedVersion,
  unpack,
} from "./apps-package.ts";

/**
 * Compare two semver versions by precedence: the core numerically, then a version without a
 * prerelease above one with it, then prerelease identifiers, numeric ones numerically.
 */
const compareVersions = (left: string, right: string) => {
  const parse = (version: string) => {
    const [core = "", prerelease] = version.split(/-(.*)/su);
    return { core: core.split(".").map(Number), prerelease: prerelease?.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.prerelease === undefined || b.prerelease === undefined)
    return (a.prerelease === undefined ? 1 : 0) - (b.prerelease === undefined ? 1 : 0);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    return numeric ? Number(x) - Number(y) : x < y ? -1 : 1;
  }
  return 0;
};

/** The base's version with its last prerelease number, or its patch, one higher. */
const next = (version: string) =>
  version.replace(/(\d+)$/u, (number) => String(Number(number) + 1));

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = process.argv[2];
    if (base === undefined)
      return yield* new AppsReleaseMismatch({ message: "Supply the base checkout's staged apps." });
    const [ours, theirs] = yield* Effect.all([stagedVersion(staged), stagedVersion(base)]);
    const directory = yield* fs.makeTempDirectoryScoped();
    const [head, previous] = yield* Effect.all([
      pack(staged, path.join(directory, "head")),
      pack(base, path.join(directory, "base")),
    ]);
    const differing = yield* differingFiles(
      yield* unpack(head.archive, path.join(directory, "head-files")),
      yield* unpack(previous.archive, path.join(directory, "base-files")),
    );
    if (differing.length === 0)
      return yield* Effect.log(`The apps package is unchanged from the base (${theirs}).`);
    if (ours === theirs)
      return yield* new AppsReleaseMismatch({
        message: `packages/apps changed from the base but keeps apps@${ours}; bump the version in packages/apps/package.json to ${next(theirs)} or later and run \`bun install\` to record it in bun.lock. See notes/apps-publishing.md. ${listFiles(differing)}`,
      });
    if (compareVersions(ours, theirs) < 0)
      return yield* new AppsReleaseMismatch({
        message: `packages/apps changed and its version moves back from ${theirs} on the base to ${ours}; take ${next(theirs)} or later in packages/apps/package.json and run \`bun install\`. A lower version may be one no deploy published, and publishing it would move the beta tag backwards. See notes/apps-publishing.md. ${listFiles(differing)}`,
      });
    yield* Effect.log(`The apps package changed and its version moves from ${theirs} to ${ours}.`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
