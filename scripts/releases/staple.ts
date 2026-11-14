/**
 * Staple Apple's ticket to one app or disk image (macos-staple.ts):
 * `node scripts/releases/staple.ts <path>`. `@electron/notarize`'s patched `stapleApp` runs it.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { StapleFailed, staple } from "./macos-staple.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [file] = process.argv.slice(2);
    if (file === undefined)
      return yield* new StapleFailed({ message: "Usage: staple.ts <app or disk image>" });
    yield* staple(file);
  }).pipe(Effect.provide(NodeServices.layer)),
);
