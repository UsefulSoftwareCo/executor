/** Build trusted runtime code once before isolated test servers start. No scenario data is shared. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeWorkerdHostBundle } from "../packages/sdk/src/node-build.ts";
import { Effect, FileSystem } from "effect";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(".local/test-runtime", { recursive: true });
    yield* writeWorkerdHostBundle(".local/test-runtime/host.json");
  }).pipe(Effect.provide(NodeServices.layer)),
);
