/**
 * Deleting your own user. Each organization the user belongs to is either deleted with them, when
 * they are its only member, or left: their personal accounts there are deleted and their
 * membership ends with the user row. The only owner of an organization that others still belong
 * to is refused, because the organization would be left with nobody able to administer it.
 */
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

/**
 * The user's live organizations with what deleting the user does to each, and the personal
 * accounts they hold in the ones they leave. An organization already being removed is gone.
 */
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

/** Show the signed-in user what deleting them would do, before they confirm. */
export const previewUserRemoval = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const planned = yield* plan(principal.userId);
  return {
    organizations: planned.organizations.map(({ role: _role, ...entry }) => entry),
    personalAccounts: planned.accounts.length,
  };
});

/**
 * Delete the signed-in user. Every refusal a retry would clear is taken before anything is
 * deleted: an organization they cannot leave, or running work in one they are deleting. Their
 * personal accounts go next, while they are still a member, so each deletion is authorized and
 * revokes its OAuth grant exactly as deleting it by hand does. The organizations only they belong
 * to are then tombstoned, which hides them at once; the caller starts each removal workflow with
 * the returned ids. The user's own records go last. A failure before that leaves the user able to
 * sign in and try again, and a repeat skips what an earlier attempt finished.
 */
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
      // Leaving already stops the account serving its apps; deleting it removes those links.
      if (yield* removeAppLinksOf(executor, sql, account))
        yield* Effect.serviceOption(ScheduleWakeup).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (wake) => wake })),
        );
      yield* removeAccount({ owner, account }).pipe(
        // Deleted since this request read the plan, by the user in another tab.
        Effect.catchTag("AccountNotFound", () => Effect.void),
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
