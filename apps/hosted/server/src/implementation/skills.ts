import { authorizeApp } from "./authorization.ts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import type { AppSkillInputs, CatalogReadOptions } from "@executor-js/sdk/core";
import { annotateSkillRead } from "@executor-js/app-templates/executor";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner, selectedVersion } from "./access.ts";

const skillAccounts = (input: Pick<typeof AppSkillInputs.list.Type, "app" | "version">) =>
  Effect.gen(function* () {
    yield* authorizeApp(input.app);
    const owner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    const accounts = yield* selectedVersion(executor, owner, input);
    return { owner, executor, accounts };
  });
export const listAppSkills = (
  input: Omit<typeof AppSkillInputs.list.Type, "owner">,
  options?: CatalogReadOptions,
) =>
  Effect.gen(function* () {
    const { owner, executor, accounts } = yield* skillAccounts(input);
    return yield* executor.skills.list({ ...input, owner, accounts }, options);
  });
export const bundleAppSkills = (
  input: Omit<typeof AppSkillInputs.list.Type, "owner">,
  options?: CatalogReadOptions,
) =>
  Effect.gen(function* () {
    const { owner, executor, accounts } = yield* skillAccounts(input);
    return yield* executor.skills.bundle({ ...input, owner, accounts }, options);
  });
export const readAppSkill = (input: Omit<typeof AppSkillInputs.read.Type, "owner">) =>
  Effect.gen(function* () {
    const { owner, executor, accounts } = yield* skillAccounts(input);
    return yield* executor.skills.read({ ...input, owner, accounts });
  });
export const hostedSkillHandlers = HttpApiBuilder.group(HostedApi, "skills", (handlers) =>
  handlers
    .handle("bundle", ({ params, query }) => bundleAppSkills({ app: params.app, ...query }))
    .handle("list", ({ params, query }) => listAppSkills({ app: params.app, ...query }))
    .handle("read", ({ params, query }) =>
      readAppSkill({ app: params.app, name: params.name, ...query }).pipe(
        Effect.tap(annotateSkillRead),
      ),
    ),
);
