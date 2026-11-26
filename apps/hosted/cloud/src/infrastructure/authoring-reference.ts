import { executorSkillFiles } from "@executor-js/app-templates/executor";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { Authoring } from "./authoring-worker.ts";

export const cloudAuthoringReference = Effect.gen(function* () {
  const authoring = yield* Cloudflare.Workers.bindWorker(Authoring);
  return authoring
    .files()
    .pipe(Effect.map(executorSkillFiles), Effect.orDie, Effect.withSpan("executor.authoring.load"));
});
