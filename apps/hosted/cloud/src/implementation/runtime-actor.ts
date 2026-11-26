import { Context, Effect, Option } from "effect";
import { CurrentOrganization, CurrentUserId } from "@executor-js/hosted-server";

export const runtimeActor = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const user = Context.get(context, CurrentUserId);
  const organization = Context.getOption(context, CurrentOrganization);
  return {
    ...(user === undefined ? {} : { "executor.user.id": user }),
    ...(Option.isSome(organization)
      ? { "executor.organization.id": organization.value.organization }
      : {}),
  };
});
