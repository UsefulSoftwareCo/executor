import { authorizeTarget } from "./authorization.ts";
/** Product authority is checked for every read; profile and account checks precede factory evaluation. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { AppSkillInputs } from "@executor-js/sdk/core";
import { annotateSkillRead } from "@executor-js/app-templates/executor";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner, selectedApp } from "./access.ts";

/** Read metadata under the request's explicit organization, using the selected account profile. */
export const listAppSkills = (input: Omit<typeof AppSkillInputs.list.Type, "owner">) =>
  Effect.gen(function* () {
    yield* authorizeTarget(input.app, input.profile);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* selectedApp(executor, owner, input.app, input.profile);
    return yield* executor.skills.list({ ...input, owner });
  });
/** Historical reads still require current access to the configured app and its code lineage. */
export const readAppSkill = (input: Omit<typeof AppSkillInputs.read.Type, "owner">) =>
  Effect.gen(function* () {
    yield* authorizeTarget(input.app, input.profile);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* selectedApp(executor, owner, input.app, input.profile);
    return yield* executor.skills.read({ ...input, owner });
  });
/** Both hosted products mount these shared authenticated handlers. */
export const hostedSkillHandlers = HttpApiBuilder.group(HostedApi, "skills", (handlers) =>
  handlers
    .handle("bundle", ({ params, query }) =>
      Effect.gen(function* () {
        yield* authorizeTarget(params.app, query.profile);
        const owner = yield* currentOwner;
        const executor = yield* Effect.flatten(HostedExecutor);
        yield* selectedApp(executor, owner, params.app, query.profile);
        return yield* executor.skills.bundle({ app: params.app, ...query, owner });
      }),
    )
    .handle("list", ({ params, query }) => listAppSkills({ app: params.app, ...query }))
    // The Executor app's skills.read tool reads here, not through the MCP skills tool. The
    // dashboard only lists skills and loads bundles, so those routes record no skill.
    .handle("read", ({ params, query }) =>
      readAppSkill({ app: params.app, name: params.name, ...query }).pipe(
        Effect.tap(annotateSkillRead),
      ),
    ),
);
