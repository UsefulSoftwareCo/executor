/** The authoring reference lives in the Authoring Worker, so the API Worker never uploads it. */
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { Authoring } from "./authoring-worker.ts";

/**
 * Read the skill files and framework reference. Only framework lookups and the published skills
 * read them, each keeping its result after the first success, so a fresh isolate makes at most
 * one call per reader. The binding resolves from the calling request's Worker environment.
 * Without the reference these requests cannot be answered, so a transport failure is a defect
 * and the next request tries again.
 */
export const cloudAuthoringReference = Effect.gen(function* () {
  const authoring = yield* Cloudflare.Workers.bindWorker(Authoring);
  return authoring
    .files()
    .pipe(Effect.map(executorSkillFiles), Effect.orDie, Effect.withSpan("executor.authoring.load"));
});
