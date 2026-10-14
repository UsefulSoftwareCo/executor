import { authorizeApp } from "./authorization.ts";
/** Product authority is checked for every read; app and account checks precede factory evaluation. */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { AppSkillInputs, CatalogReadOptions } from "@executor-js/sdk/core";
import { annotateSkillRead } from "@executor-js/app-templates/executor";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner, selectedVersion } from "./access.ts";

/**
 * Check the app and resolve the caller's accounts under the request's explicit organization, for
 * the requirements of the deployment the read pins, after its lineage check.
 */
const skillAccounts = (input: Pick<typeof AppSkillInputs.list.Type, "app" | "deployment">) =>
  Effect.gen(function* () {
    yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const accounts = yield* selectedVersion(executor, owner, input);
    return { owner, executor, accounts };
  });
/** Read metadata using the caller's accounts. */
export const listAppSkills = (
  input: Omit<typeof AppSkillInputs.list.Type, "owner">,
  options?: CatalogReadOptions,
) =>
  Effect.gen(function* () {
    const { owner, executor, accounts } = yield* skillAccounts(input);
    return yield* executor.skills.list({ ...input, owner, accounts }, options);
  });
/** Historical reads still require current access to the configured app and its code lineage. */
export const readAppSkill = (input: Omit<typeof AppSkillInputs.read.Type, "owner">) =>
  Effect.gen(function* () {
    const { owner, executor, accounts } = yield* skillAccounts(input);
    return yield* executor.skills.read({ ...input, owner, accounts });
  });
/** Both hosted products mount these shared authenticated handlers. */
export const hostedSkillHandlers = HttpApiBuilder.group(HostedApi, "skills", (handlers) =>
  handlers
    .handle("bundle", ({ params, query }) =>
      Effect.gen(function* () {
        const { owner, executor, accounts } = yield* skillAccounts({ app: params.app, ...query });
        return yield* executor.skills.bundle({ app: params.app, ...query, owner, accounts });
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
