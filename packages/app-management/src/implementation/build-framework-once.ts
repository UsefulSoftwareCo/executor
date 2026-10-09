/**
 * The data step that stores each retained build's `apps` framework once. Builds retained before the
 * split inline the framework in `<build>.json`; this writes `<build>/worker.json` and the shared
 * framework object beside it, and never touches `<build>.json`. See
 * notes/build-framework-migration.md.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { BlobStore, type BlobStorage, BuildId, DeploymentId } from "@executor-js/sdk/core";
import {
  splitInlinedWorkerBuild,
  type BuildSplitOutcome,
} from "@executor-js/sdk/workerd/migration";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

/** The host services the step reads and writes through: the store that holds retained builds. */
export interface BuildFrameworkHost {
  readonly blobs: BlobStorage;
}

/** Each build once, with the first owner and deployment that reference it. */
const ReferencedBuilds = Schema.Array(
  Schema.Struct({ build: BuildId, owner: Schema.String, deployment: DeploymentId }),
);

/**
 * Every build any deployment row names, active or not: rolled-back deployments and builds a
 * workflow run pinned are loadable too. Builds no row names cannot be loaded and are skipped.
 */
const referencedBuilds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select build, min(owner) as owner, min(id) as deployment
    from executor_deployments group by build`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ReferencedBuilds)),
  );
});

const splitBuild = (
  host: BuildFrameworkHost,
  build: BuildId,
  deployment: DeploymentId,
  mode: DataStepMode,
) =>
  splitInlinedWorkerBuild(build, deployment, mode).pipe(
    Effect.provideService(BlobStore, host.blobs),
    // Byte counts and framework labels stay out of the journal, which holds outcomes only.
    Effect.tap((split) => Effect.log("Build framework split", { build, mode, ...split })),
    Effect.map((split): BuildSplitOutcome => split.outcome),
  );

/**
 * Split every referenced build. Each item is safe to handle again: a verified record reads as
 * `already-split`, and a record whose check failed is rewritten from `<build>.json`.
 */
export const buildFrameworkOnceStep = (
  host: BuildFrameworkHost,
  name: string,
): DataStep<SqlClient.SqlClient> => ({
  name,
  retry: ["failed"],
  // A report after apply checks every build again; each should then be `already-split`.
  reportsAfterApply: true,
  items: referencedBuilds.pipe(
    Effect.map((builds) =>
      builds.map(({ build, owner, deployment }) => ({
        id: build,
        owner,
        run: (mode: DataStepMode) => splitBuild(host, build, deployment, mode),
      })),
    ),
  ),
});
