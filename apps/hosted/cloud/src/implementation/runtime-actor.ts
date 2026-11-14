/** Whom a Cloud app runtime operation runs for, as its spans record it. */
import { Context, Effect, Option } from "effect";
import { CurrentOrganization, CurrentUserId } from "@executor-js/hosted-server";

/**
 * The opaque user and organization ids the current context holds, read without I/O. Work that runs
 * for no signed-in caller, such as a webhook delivery, holds neither.
 */
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
