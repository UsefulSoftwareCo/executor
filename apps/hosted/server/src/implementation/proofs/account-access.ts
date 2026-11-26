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

const checkAccountAccess = (account: AccountId) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    yield* requireAccountOwnerAs(actor, account);
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

const grant = <A extends AccountAction>(action: A) =>
  Effect.flatMap(AccountTargets[action], ({ account }) =>
    Effect.map(checkAccountAccess(account), (checked) => checked as AccountProof<A>),
  );

export const AccountGrants = {
  inspect: grant("inspect"),
  use: grant("use"),
  reconnect: grant("reconnect"),
  rename: grant("rename"),
  delete: grant("delete"),
};

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

export const requireAccountTargetLive = Layer.mergeAll(
  Layer.succeed(RequireAccountInspect, target("inspect")),
  Layer.succeed(RequireAccountUse, target("use")),
  Layer.succeed(RequireAccountReconnect, target("reconnect")),
  Layer.succeed(RequireAccountRename, target("rename")),
  Layer.succeed(RequireAccountDelete, target("delete")),
);
