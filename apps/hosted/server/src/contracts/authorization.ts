import { Context } from "effect";
import { noAuthority, type Action, type AuthorizationPolicy } from "@executor-js/authorization";

/** Every delegated HTTP operation declares its shared product action. */
export const RequiredAction = Context.Service<Action>("hosted/RequiredAction");
/** Request authority is explicit for cookies, OAuth and keys; omitted authority denies access. */
export const CurrentAuthorization = Context.Reference<AuthorizationPolicy>(
  "hosted/CurrentAuthorization",
  { defaultValue: () => noAuthority },
);
