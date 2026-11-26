import { AccountId, type OwnerId } from "@executor-js/sdk/core";
import { Context, type Schema } from "effect";
import type { HttpMethod } from "effect/http";
import { type HttpApiEndpoint, HttpApiMiddleware } from "effect/http-api";
import type { Action } from "@executor-js/authorization";
import { RequiredAction } from "./authorization.ts";
import { OrganizationForbidden } from "./organization.ts";

export type AccountAction = "inspect" | "use" | "reconnect" | "rename" | "delete";

declare const evidence: unique symbol;

export interface AccountProof<A extends AccountAction> {
  readonly [evidence]: A;
  readonly owner: OwnerId;
  readonly account: typeof AccountId.Type;
}

export interface AccountTarget<A extends AccountAction> {
  readonly action: A;
}

const target = <A extends AccountAction>(action: A) =>
  Context.Service<AccountTarget<A>, { readonly account: typeof AccountId.Type }>(
    `hosted/AccountTarget/${action}`,
  );

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
  delete: target("delete"),
};

export class RequireAccountInspect extends HttpApiMiddleware.Service<
  RequireAccountInspect,
  { provides: AccountTarget<"inspect"> }
>()("hosted/RequireAccountInspect", { error: OrganizationForbidden }) {}

export class RequireAccountUse extends HttpApiMiddleware.Service<
  RequireAccountUse,
  { provides: AccountTarget<"use"> }
>()("hosted/RequireAccountUse", { error: OrganizationForbidden }) {}

export class RequireAccountReconnect extends HttpApiMiddleware.Service<
  RequireAccountReconnect,
  { provides: AccountTarget<"reconnect"> }
>()("hosted/RequireAccountReconnect", { error: OrganizationForbidden }) {}

export class RequireAccountRename extends HttpApiMiddleware.Service<
  RequireAccountRename,
  { provides: AccountTarget<"rename"> }
>()("hosted/RequireAccountRename", { error: OrganizationForbidden }) {}

export class RequireAccountDelete extends HttpApiMiddleware.Service<
  RequireAccountDelete,
  { provides: AccountTarget<"delete"> }
>()("hosted/RequireAccountDelete", { error: OrganizationForbidden }) {}

interface AccountActionDeclaration {
  readonly middleware: unknown;
  readonly tokenAction: Action;
}

const AccountActions = {
  inspect: { middleware: RequireAccountInspect, tokenAction: "read" },
  use: { middleware: RequireAccountUse, tokenAction: "run" },
  reconnect: { middleware: RequireAccountReconnect, tokenAction: "manage" },
  rename: { middleware: RequireAccountRename, tokenAction: "manage" },
  delete: { middleware: RequireAccountDelete, tokenAction: "manage" },
} as const satisfies Record<AccountAction, AccountActionDeclaration>;

type AccountMiddleware =
  | RequireAccountInspect
  | RequireAccountUse
  | RequireAccountReconnect
  | RequireAccountRename
  | RequireAccountDelete;

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
      ([Params] extends [never] ? { readonly "missing `account` path parameter": never } : unknown),
  ) => endpoint.middleware(middleware).annotate(RequiredAction, tokenAction);
};

export const requireAccount = {
  inspect: attach(AccountActions.inspect),
  use: attach(AccountActions.use),
  reconnect: attach(AccountActions.reconnect),
  rename: attach(AccountActions.rename),
  delete: attach(AccountActions.delete),
};
