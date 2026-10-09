/** Recognize the Executor app's own skill documents in telemetry without naming anyone else's. */
import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { executorSkillDigests } from "./executor-skill-digests.gen.ts";

/**
 * Record a skill document an agent read on the current span. A document whose content is a file
 * the Executor app publishes is named by skill and file. Every other skill belongs to a customer's
 * app, so only its source is recorded, never the app, skill or file name. Matching on content also
 * tells a renamed Executor app and a customer skill that reuses an Executor skill name apart.
 */
export const annotateSkillRead = (document: {
  readonly name: string;
  readonly file: string;
  readonly content: string;
}): Effect.Effect<void> =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(document.content)),
  ).pipe(
    Effect.flatMap((digest) => {
      const path = `${document.name}/${document.file}`;
      return Effect.annotateCurrentSpan(
        Object.hasOwn(executorSkillDigests, path) &&
          executorSkillDigests[path] === Hex.encode(new Uint8Array(digest))
          ? {
              "executor.skill.operation": "read",
              "executor.skill.source": "executor",
              "executor.skill.name": document.name,
              "executor.skill.file": document.file,
            }
          : { "executor.skill.operation": "read", "executor.skill.source": "customer" },
      );
    }),
  );
