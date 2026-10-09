/**
 * Account grants: evidence that a request's actor may perform one action on one account.
 *
 * An account endpoint declares its action as `endpoint.pipe(requireAccount.<action>)`. The
 * action's middleware provides the route's `:account` as its target. Use cases yield the action's
 * grant (`implementation/proofs`), which checks the target and returns its proof. An endpoint
 * without the middleware leaves the target unmet and fails to type-check.
 *
 * The middleware does not run the check: HttpApi middleware can only depend on application
 * services, and the policy check needs this request's database and executor.
 */
import { AccountId, type OwnerId } from "@executor-js/sdk/core";
import { Context, type Schema } from "effect";
import type { HttpMethod } from "effect/http";
import { type HttpApiEndpoint, HttpApiMiddleware } from "effect/http-api";
import type { Action } from "@executor-js/authorization";
import { RequiredAction } from "./authorization.ts";
import { OrganizationForbidden } from "./organization.ts";
import type { AccountAccess } from "./resource-access.ts";

/**
 * Account actions from #752. "inspect" covers metadata and health. "rename" is not in #752 yet;
 * it covers the label and description.
 */
export type AccountAction = "inspect" | "use" | "reconnect" | "rename" | "share" | "delete";

/** Type-only key: it has no runtime value, so no other module can construct a proof. */
declare const evidence: unique symbol;

/**
 * Evidence that the request's actor holds `A` on exactly this account of exactly this owner.
 * Proofs for different actions are unrelated types, so one never stands in for another.
 */
export interface AccountProof<A extends AccountAction> {
  readonly [evidence]: A;
  readonly owner: OwnerId;
  readonly account: typeof AccountId.Type;
  readonly access: typeof AccountAccess.Type;
}

/** Context identity of the account a request acts on for `A`; unrelated across actions. */
export interface AccountTarget<A extends AccountAction> {
  readonly action: A;
}

const target = <A extends AccountAction>(action: A) =>
  Context.Service<AccountTarget<A>, { readonly account: typeof AccountId.Type }>(
    `hosted/AccountTarget/${action}`,
  );

/** Targets name an account only; the grant for the same action checks it. */
export const AccountTargets: {
  readonly [A in AccountAction]: Context.Service<
    AccountTarget<A>,
    { readonly account: typeof AccountId.Type }
  >;
} = {
  inspect: target("inspect"),
  use: target("use"),
  reconnect: target("reconnect"),
  rename: target("rename"),
  share: target("share"),
  delete: target("delete"),
};

/*
 * Each middleware provides the route's `:account` as its action's target.
 */

/** Read account metadata, health and policy. */
export class RequireAccountInspect extends HttpApiMiddleware.Service<
  RequireAccountInspect,
  { provides: AccountTarget<"inspect"> }
>()("hosted/RequireAccountInspect", { error: OrganizationForbidden }) {}

/** Run checks or tools with the account's credentials. */
export class RequireAccountUse extends HttpApiMiddleware.Service<
  RequireAccountUse,
  { provides: AccountTarget<"use"> }
>()("hosted/RequireAccountUse", { error: OrganizationForbidden }) {}

/** Replace the account's credentials. */
export class RequireAccountReconnect extends HttpApiMiddleware.Service<
  RequireAccountReconnect,
  { provides: AccountTarget<"reconnect"> }
>()("hosted/RequireAccountReconnect", { error: OrganizationForbidden }) {}

/** Change the account's label or description. */
export class RequireAccountRename extends HttpApiMiddleware.Service<
  RequireAccountRename,
  { provides: AccountTarget<"rename"> }
>()("hosted/RequireAccountRename", { error: OrganizationForbidden }) {}

/** Change who the account is shared with. */
export class RequireAccountShare extends HttpApiMiddleware.Service<
  RequireAccountShare,
  { provides: AccountTarget<"share"> }
>()("hosted/RequireAccountShare", { error: OrganizationForbidden }) {}

/** Delete the account and its saved credentials. */
export class RequireAccountDelete extends HttpApiMiddleware.Service<
  RequireAccountDelete,
  { provides: AccountTarget<"delete"> }
>()("hosted/RequireAccountDelete", { error: OrganizationForbidden }) {}

/**
 * An account action's middleware and the action an API token must hold to perform it. Effect
 * exports no type for a middleware class; `attach` accepts only account middleware, and an
 * endpoint given another action's middleware leaves its use case's target unmet.
 */
interface AccountActionDeclaration {
  readonly middleware: unknown;
  readonly tokenAction: Action;
}

/** Each account action's declaration. */
const AccountActions = {
  inspect: { middleware: RequireAccountInspect, tokenAction: "read" },
  use: { middleware: RequireAccountUse, tokenAction: "run" },
  reconnect: { middleware: RequireAccountReconnect, tokenAction: "manage" },
  rename: { middleware: RequireAccountRename, tokenAction: "manage" },
  share: { middleware: RequireAccountShare, tokenAction: "manage" },
  delete: { middleware: RequireAccountDelete, tokenAction: "manage" },
} as const satisfies Record<AccountAction, AccountActionDeclaration>;

type AccountMiddleware =
  | RequireAccountInspect
  | RequireAccountUse
  | RequireAccountReconnect
  | RequireAccountRename
  | RequireAccountShare
  | RequireAccountDelete;

/**
 * Attach an account action's middleware and annotate the RequiredAction an API token must hold.
 * The middleware reads the route's `account` parameter, so the endpoint must decode one as an
 * AccountId; any other endpoint fails to type-check.
 */
const attach = <I extends AccountMiddleware, S>(declaration: {
  readonly middleware: Context.Key<I, S>;
  readonly tokenAction: Action;
}) => {
  const { middleware, tokenAction } = declaration;
  return <
    Identifier extends string,
    Method extends HttpMethod.HttpMethod,
    Path extends string,
    Params extends Schema.Top & { readonly Type: { readonly account: typeof AccountId.Type } },
    Query extends Schema.Top,
    Payload extends Schema.Top,
    Headers extends Schema.Top,
    Success extends Schema.Top,
    Error extends Schema.Top,
    Middleware,
    MiddlewareServices,
  >(
    endpoint: HttpApiEndpoint.HttpApiEndpoint<
      Identifier,
      Method,
      Path,
      Params,
      Query,
      Payload,
      Headers,
      Success,
      Error,
      Middleware,
      MiddlewareServices
    > &
      // An endpoint without path parameters has `never` params, which satisfies any constraint.
      ([Params] extends [never] ? { readonly "missing `account` path parameter": never } : unknown),
  ) => endpoint.middleware(middleware).annotate(RequiredAction, tokenAction);
};

/**
 * Declare an account endpoint's action: `endpoint.pipe(requireAccount.delete)`. Each entry
 * attaches that action's middleware and annotates its API token action from AccountActions.
 */
export const requireAccount = {
  inspect: attach(AccountActions.inspect),
  use: attach(AccountActions.use),
  reconnect: attach(AccountActions.reconnect),
  rename: attach(AccountActions.rename),
  share: attach(AccountActions.share),
  delete: attach(AccountActions.delete),
};
