/**
 * The only module that may mint account proofs. `AccountGrants.<action>` checks the request's
 * target for that action and returns its proof; this module also implements the target
 * middleware declared in `contracts/account-grants.ts`. `executor/no-proof-forgery` rejects
 * `as AccountProof` outside this directory.
 */
import { AccountId } from "@executor-js/sdk/core";
import { permitsApp } from "@executor-js/authorization";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import {
  AccountTargets,
  RequireAccountDelete,
  RequireAccountInspect,
  RequireAccountReconnect,
  RequireAccountRename,
  RequireAccountShare,
  RequireAccountUse,
  type AccountAction,
  type AccountProof,
} from "../../contracts/account-grants.ts";
import { CurrentAuthorization } from "../../contracts/authorization.ts";
import { HostedExecutor } from "../../contracts/executor.ts";
import { OrganizationForbidden, organizationOwner } from "../../contracts/organization.ts";
import {
  currentResourceAuthority,
  requireAccountAccessAs,
  visibleAppsAs,
} from "../resource-policy.ts";

/** Until account roles exist, each action maps onto the current use and manage policy. */
const policy = {
  inspect: "read",
  use: "use",
  reconnect: "manage",
  rename: "manage",
  share: "manage",
  delete: "manage",
} as const satisfies Record<AccountAction, "read" | "use" | "manage">;

/**
 * Check the current membership and the account's policy for `action`. An API token limited to
 * some apps also needs one of them, visible to its user, to use this account.
 */
const checkAccountAccess = (account: AccountId, action: AccountAction) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const access = yield* requireAccountAccessAs(actor, account, policy[action]);
    // The owner comes from the organization the policy was checked in, never from the caller.
    const owner = organizationOwner(actor.organization);
    const scope = yield* CurrentAuthorization;
    if (scope.tools.kind !== "all") {
      const executor = yield* Effect.flatten(HostedExecutor);
      const apps = yield* executor.apps.list({ owner, account });
      const reachable = yield* visibleAppsAs(
        actor,
        apps.filter((app) => permitsApp(scope, app.id)),
      );
      if (reachable.length === 0) return yield* new OrganizationForbidden();
    }
    return { owner, account, access };
  });

/** Check the request's target for `action` and return its proof. */
const grant = <A extends AccountAction>(action: A) =>
  Effect.flatMap(AccountTargets[action], ({ account }) =>
    // The only mint: this value is evidence for `A` because the check for `A` just passed.
    Effect.map(checkAccountAccess(account, action), (checked) => checked as AccountProof<A>),
  );

/** Use cases yield the grant for their action to read the checked owner, account and policy. */
export const AccountGrants = {
  inspect: grant("inspect"),
  use: grant("use"),
  reconnect: grant("reconnect"),
  rename: grant("rename"),
  share: grant("share"),
  delete: grant("delete"),
};

/** Provide the route's `:account` as the target for `action`. */
const target =
  <A extends AccountAction>(action: A) =>
  <E, R>(response: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const account = yield* Schema.decodeUnknownEffect(AccountId)(params.account).pipe(
        Effect.mapError(() => new OrganizationForbidden()),
      );
      return yield* Effect.provideService(response, AccountTargets[action], { account });
    });

/** Every account target middleware; provide it beside requireOrganizationLive. */
export const requireAccountTargetLive = Layer.mergeAll(
  Layer.succeed(RequireAccountInspect, target("inspect")),
  Layer.succeed(RequireAccountUse, target("use")),
  Layer.succeed(RequireAccountReconnect, target("reconnect")),
  Layer.succeed(RequireAccountRename, target("rename")),
  Layer.succeed(RequireAccountShare, target("share")),
  Layer.succeed(RequireAccountDelete, target("delete")),
);
