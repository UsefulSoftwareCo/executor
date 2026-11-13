/**
 * Fail a pull request that changes the `apps` package without bumping its version. Merging to
 * `main` allocates the version and the deploy publishes it, so two different packages must never
 * carry the same version, even before either is on npm.
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
        message: `packages/apps changed from the base but keeps apps@${ours}; bump the version in packages/apps/package.json and run \`bun install\` to record it in bun.lock. See notes/apps-publishing.md. ${listFiles(differing)}`,
      });
    yield* Effect.log(`The apps package changed and its version moves from ${theirs} to ${ours}.`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
