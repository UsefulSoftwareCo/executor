/**
 * The only module that may mint account proofs. `AccountGrants.<action>` checks the request's
 * target for that action and returns its proof; this module also implements the target
 * middleware declared in `contracts/account-grants.ts`. `executor/no-proof-forgery` rejects
 * `as AccountProof` outside this directory.
 */
import { AccountId } from "@executor-js/sdk/core";
import { permittedAppIds } from "@executor-js/authorization";
import { callerLinkedAccounts } from "../app-accounts.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import {
  AccountTargets,
  RequireAccountDelete,
  RequireAccountInspect,
  RequireAccountReconnect,
  RequireAccountRename,
  RequireAccountUse,
  type AccountAction,
  type AccountProof,
} from "../../contracts/account-grants.ts";
import { CurrentPolicy } from "../../contracts/authorization.ts";
import { HostedExecutor } from "../../contracts/executor.ts";
import { OrganizationForbidden, organizationOwner } from "../../contracts/organization.ts";
import {
  currentResourceAuthority,
  requireAccountOwnerAs,
  visibleAppsAs,
} from "../resource-policy.ts";

/**
 * Check the current membership and that the actor owns the account. Until account roles exist,
 * ownership permits every action. An API token limited to some apps also needs one of them,
 * visible to its user, that its user linked this account to.
 */
const checkAccountAccess = (account: AccountId) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    yield* requireAccountOwnerAs(actor, account);
    // The owner comes from the organization the policy was checked in, never from the caller.
    const owner = organizationOwner(actor.organization);
    const scope = yield* CurrentPolicy;
    if (scope.tools.kind !== "all") {
      const executor = yield* Effect.flatten(HostedExecutor);
      const apps = yield* executor.apps.list({ owner, ids: permittedAppIds(scope) });
      const reachable = yield* visibleAppsAs(actor, apps);
      const linked = yield* callerLinkedAccounts(reachable.map((app) => app.id));
      if (!linked.some((entry) => entry.id === account)) return yield* new OrganizationForbidden();
    }
    return { owner, account };
  });

/** Check the request's target for `action` and return its proof. */
const grant = <A extends AccountAction>(action: A) =>
  Effect.flatMap(AccountTargets[action], ({ account }) =>
    // The only mint: this value is evidence for `A` because the check for `A` just passed.
    Effect.map(checkAccountAccess(account), (checked) => checked as AccountProof<A>),
  );

/** Use cases yield the grant for their action to read the checked owner and account. */
export const AccountGrants = {
  inspect: grant("inspect"),
  use: grant("use"),
  reconnect: grant("reconnect"),
  rename: grant("rename"),
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
  Layer.succeed(RequireAccountDelete, target("delete")),
);
