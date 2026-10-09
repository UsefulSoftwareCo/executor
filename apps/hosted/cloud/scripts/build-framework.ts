/** Generate the Executor app's skills and framework reference for Cloud. */
import { generateFrameworkReference } from "../../../../packages/apps/scripts/reference.mjs";
import { readExecutorSkillDocuments } from "@executor-js/app-templates/executor";
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
  }).pipe(Effect.provide(NodeServices.layer)),
);
