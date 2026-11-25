import { Context } from "effect";
import { noAuthority, type Action, type AuthorizationPolicy } from "@executor-js/authorization";

export const RequiredAction = Context.Service<Action>("hosted/RequiredAction");
export const CurrentPolicy = Context.Reference<AuthorizationPolicy>("hosted/CurrentPolicy", {
  defaultValue: () => noAuthority,
});
