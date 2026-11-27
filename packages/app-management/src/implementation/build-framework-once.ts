import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { BlobStore, type BlobStorage, BuildId, VersionId } from "@executor-js/sdk/core";
import {
  splitInlinedWorkerBuild,
  type BuildSplitOutcome,
} from "@executor-js/sdk/workerd/migration";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

export interface BuildFrameworkHost {
  readonly blobs: BlobStorage;
}

const ReferencedBuilds = Schema.Array(
  Schema.Struct({ build: BuildId, owner: Schema.String, version: VersionId }),
);

const referencedBuilds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`select build, min(owner) as owner, min(id) as version
    from executor_deployments group by build`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ReferencedBuilds)),
  );
});

const splitBuild = (
  host: BuildFrameworkHost,
  build: BuildId,
  version: VersionId,
  mode: DataStepMode,
) =>
  splitInlinedWorkerBuild(build, version, mode).pipe(
    Effect.provideService(BlobStore, host.blobs),
    Effect.tap((split) => Effect.log("Build framework split", { build, mode, ...split })),
    Effect.map((split): BuildSplitOutcome => split.outcome),
  );

export const buildFrameworkOnceStep = (
  host: BuildFrameworkHost,
  name: string,
): DataStep<SqlClient.SqlClient> => ({
  name,
  retry: ["failed"],
  reportsAfterApply: true,
  items: referencedBuilds.pipe(
    Effect.map((builds) =>
      builds.map(({ build, owner, version }) => ({
        id: build,
        owner,
        run: (mode: DataStepMode) => splitBuild(host, build, version, mode),
      })),
    ),
  ),
});
