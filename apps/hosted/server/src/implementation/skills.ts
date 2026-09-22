import { authorizeApp } from "./authorization.ts";
/** Product authority is checked for every read; skills never resolve the app's credentials. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { AppSkillInputs } from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { appReaderOwner } from "./access.ts";

/** Read metadata under the request's explicit organization, including apps awaiting account setup. */
export const listAppSkills = (input: Omit<typeof AppSkillInputs.list.Type, "owner">) =>
  Effect.gen(function* () {
    yield* authorizeApp(input.app);
    const owner = yield* appReaderOwner(input.app);
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.skills.list({ ...input, owner });
  });
/** Historical reads still require current access to the configured app and its code lineage. */
export const readAppSkill = (input: Omit<typeof AppSkillInputs.read.Type, "owner">) =>
  Effect.gen(function* () {
    yield* authorizeApp(input.app);
    const owner = yield* appReaderOwner(input.app);
    const executor = yield* Effect.flatten(HostedExecutor);
    return yield* executor.skills.read({ ...input, owner });
  });
/** Both hosted products mount these shared authenticated handlers. */
export const hostedSkillHandlers = HttpApiBuilder.group(HostedApi, "skills", (handlers) =>
  handlers
    .handle("bundle", ({ params, query }) =>
      Effect.gen(function* () {
        yield* authorizeApp(params.app);
        const owner = yield* appReaderOwner(params.app);
        const executor = yield* Effect.flatten(HostedExecutor);
        return yield* executor.skills.bundle({ app: params.app, ...query, owner });
      }),
    )
    .handle("list", ({ params, query }) => listAppSkills({ app: params.app, ...query }))
    .handle("read", ({ params, query }) =>
      readAppSkill({ app: params.app, name: params.name, ...query }),
    ),
);
