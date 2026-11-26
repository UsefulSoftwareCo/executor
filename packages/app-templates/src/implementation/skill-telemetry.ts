import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { executorSkillDigests } from "./executor-skill-digests.gen.ts";

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
