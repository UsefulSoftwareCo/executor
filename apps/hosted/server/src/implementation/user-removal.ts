import { Effect, Option, Schema } from "effect";
import { AccountId, StorageError } from "@executor-js/sdk/core";
import { SessionAuthentication, CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import { fullAuthority } from "@executor-js/authorization";
import { CurrentPolicy } from "../contracts/authorization.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import {
  CurrentOrganization,
  OrganizationId,
  OrganizationRole,
  organizationOwner,
} from "../contracts/organization.ts";
import { OrganizationRemovals } from "../contracts/organization-removal.ts";
import {
  UserRemovalBlocked,
  type UserRemovalOrganization,
  type UserRemovalOutcome,
} from "../contracts/user-removal.ts";
import { removeAccount } from "./accounts.ts";
import { removeAppLinksOf } from "./app-accounts.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { policyDatabase } from "./resource-policy.ts";

const Membership = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Schema.String,
  role: OrganizationRole,
  members: Schema.Number,
  owners: Schema.Number,
});
const PersonalAccount = Schema.Struct({ account: AccountId, organization: OrganizationId });

const outcome = (membership: typeof Membership.Type): UserRemovalOutcome =>
  membership.members === 1
    ? "delete"
    : membership.role === "owner" && membership.owners === 1
      ? "blocked"
      : "leave";

const plan = (user: string) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    const organizations = yield* sql`select o.id, o.name, o.slug, m.role,
        (select count(*)::int from member x where x."organizationId" = o.id) as members,
        (select count(*)::int from member x where x."organizationId" = o.id and x.role = 'owner') as owners
      from member m join organization o on o.id = m."organizationId"
      where m."userId" = ${user}
        and not exists (select 1 from hosted_organization_removal r where r.organization_id = o.id)
      order by o.name, o.id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Membership))),
      Effect.mapError(() => new StorageError()),
    );
    const listed: ReadonlyArray<
      UserRemovalOrganization & { readonly role: typeof OrganizationRole.Type }
    > = organizations.map((membership) => ({
      id: membership.id,
      name: membership.name,
      slug: membership.slug,
      role: membership.role,
      outcome: outcome(membership),
    }));
    const left = listed.filter((entry) => entry.outcome === "leave").map((entry) => entry.id);
    const accounts =
      left.length === 0
        ? []
        : yield* sql`select account_id as account, organization_id as organization
            from hosted_account_access
            where kind = 'personal' and personal_user_id = ${user}
              and organization_id in ${sql.in(left)}
            order by organization_id, account_id`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PersonalAccount))),
            Effect.mapError(() => new StorageError()),
          );
    return { organizations: listed, accounts };
  });

export const previewUserRemoval = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const planned = yield* plan(principal.userId);
  return {
    organizations: planned.organizations.map(({ role: _role, ...entry }) => entry),
    personalAccounts: planned.accounts.length,
  };
});

export const removeUser = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const user = principal.userId;
  const planned = yield* plan(user);
  const blocked = planned.organizations.filter((entry) => entry.outcome === "blocked");
  if (blocked.length > 0)
    return yield* new UserRemovalBlocked({ organizations: blocked.map((entry) => entry.name) });
  const executor = yield* Effect.flatten(HostedExecutor);
  const sql = yield* policyDatabase;
  const deleted = planned.organizations.filter((entry) => entry.outcome === "delete");
  for (const organization of deleted)
    yield* executor.owners.check({ owner: organizationOwner(organization.id) });
  for (const organization of planned.organizations) {
    if (organization.outcome !== "leave") continue;
    const owner = organizationOwner(organization.id);
    for (const { account } of planned.accounts.filter(
      (entry) => entry.organization === organization.id,
    )) {
      if (yield* removeAppLinksOf(executor, sql, account))
        yield* Effect.serviceOption(ScheduleWakeup).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (wake) => wake })),
        );
      yield* removeAccount({ owner, account }).pipe(
        Effect.catchTag("AccountNotFound", () => Effect.void),
        Effect.catchTag(
          "OrganizationForbidden",
          () => new UserRemovalBlocked({ organizations: [organization.name] }),
        ),
        Effect.provideService(CurrentOrganization, {
          organization: organization.id,
          role: organization.role,
          owner,
        }),
        Effect.provideService(CurrentUserId, user),
        Effect.provideService(CurrentPolicy, fullAuthority),
      );
    }
  }
  const removals = yield* OrganizationRemovals;
  for (const organization of deleted) yield* removals.begin(organization.id, organization.id);
  yield* (yield* SessionAuthentication).removeUser(user);
  return {
    organizations: deleted.map((entry) => entry.id),
    personalAccounts: planned.accounts.length,
  };
});
