/**
 * Generate the Executor app's skills and framework reference for Cloud, and the revision of the
 * API the Executor app reads. Generating the API document takes too long for a request's isolate.
 */
import { generateFrameworkReference } from "../../../../packages/apps/scripts/reference.mjs";
import { readExecutorSkillDocuments } from "@executor-js/app-templates/executor";
import { hostedApiRevision } from "@executor-js/hosted-server";
import { executorCloudApiDocument } from "../src/contracts/api.ts";
import { builtApiOrigin } from "../src/contracts/browser.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, FileSystem, Path } from "effect";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(new URL("../../../../", import.meta.url));
    yield* fs.makeDirectory(path.join(root, "apps/hosted/cloud/.generated"), { recursive: true });
    const documents = yield* readExecutorSkillDocuments;
    const reference = yield* Effect.promise(() => generateFrameworkReference());
    yield* fs.writeFileString(
      path.join(root, "apps/hosted/cloud/.generated/executor-authoring.json"),
      JSON.stringify({
        ...Object.fromEntries(documents),
        "framework-reference.json": JSON.stringify(reference),
      }),
    );
    // Every deployed stage serves these exact bytes; see `servesBuiltApiDocument`.
    yield* fs.writeFileString(
      path.join(root, "apps/hosted/cloud/.generated/executor-api-revision.json"),
      JSON.stringify({
        revision: yield* hostedApiRevision(
          JSON.stringify(executorCloudApiDocument(builtApiOrigin)),
        ),
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
