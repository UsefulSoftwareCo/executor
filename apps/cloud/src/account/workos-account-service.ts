import { Context, Effect, Layer } from "effect";

import { AccountProvider, MemberDirectory, type AccountHeaders } from "@executor-js/api/server";
import {
  AccountError,
  AccountForbidden,
  AccountNoOrganization,
  AccountUnauthorized,
} from "@executor-js/api";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import type { Session } from "../auth/middleware";
import { WorkOSClient } from "../auth/workos";
import { ensureOrganizationBackfilled, mirrorInvitedMember } from "../auth/mirror-feeders";
import { WorkOsMirror, mirrorMembershipFromWorkOs } from "../auth/workos-mirror";
import { ORG_SELECTOR_HEADER, authorizeOrganizationSelector } from "../auth/organization";
import { AutumnService } from "../extensions/billing/service";
import { forkReportMemberSeats } from "../extensions/billing/member-seats";
import {
  countSeatsUsed,
  getMemberLimitForPlan,
  selectActiveMemberLimitPlan,
} from "../extensions/billing/plans";

// The per-request resolved caller, injected by the cookie-only session
// middleware in `account-api.ts`. Carries the authenticated WorkOS session, or
// `null` when the `wos-session` cookie is missing/invalid — the service maps
// `null` to AccountUnauthorized (401) at the method boundary, exactly where the
// inline `requireSession` used to. This is the SINGLE cookie-resolution path:
// the same `WorkOSClient.authenticateSealedSession` the rest of cloud uses.
export class AccountCaller extends Context.Service<
  AccountCaller,
  { readonly session: Session | null }
>()("@executor-js/cloud/AccountCaller") {}

// ---------------------------------------------------------------------------
// Cloud AccountProvider — implements the provider-neutral account surface over
// WorkOS. The shared `AccountHandlers` call this; self-host provides its own
// Better Auth implementation of the same shape.
//
// The caller is resolved ONCE per request by the cookie-only session
// middleware in `account-api.ts` (the SAME `WorkOSClient.authenticateSealedSession`
// off the `wos-session` cookie that `SessionAuthLive` uses) and injected here as
// the `SessionContext`. This service no longer parses the cookie itself: there
// is exactly one cookie-resolution path. It still accepts ONLY the wos-session
// sealed-session cookie — it is NOT routed through the api-key-accepting
// executor identity provider — so the credentials `/account/*` accepts are
// byte-identical to before.
//
// It then runs the EXACT logic that used to live in `auth/handlers.ts`
// (me / API keys) and `org/handlers.ts` (members / roles / invite / role /
// name). Native WorkOS / store failures are mapped at this boundary onto the
// neutral account errors so the shared UI sees one shape:
//   WorkOSError | UserStoreError | ApiKeyManagementError | WorkOsMirrorError → AccountError
//   no organization in session                           → AccountNoOrganization
//   not-an-admin / over-seat-limit / not-allowed         → AccountForbidden
// ---------------------------------------------------------------------------

const MAX_API_KEY_NAME_LENGTH = 80;

// Lift any cloud-side tagged failure (WorkOSError / UserStoreError /
// ApiKeyManagementError — none of which carry a safe user-facing message) onto
// the neutral AccountError (500), matching the cloud handlers' httpApiStatus.
const toAccountError = () => Effect.fail(new AccountError({ message: "Account request failed" }));

export const workosAccountProvider: Layer.Layer<
  AccountProvider,
  never,
  | WorkOSClient
  | UserStoreService
  | WorkOsMirror
  | MemberDirectory
  | ApiKeyService
  | AutumnService
  | AccountCaller
> = Layer.effect(AccountProvider)(
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const apiKeys = yield* ApiKeyService;
    const autumn = yield* AutumnService;
    const users = yield* UserStoreService;
    // Membership writes below go to WorkOS FIRST (the authority), then are
    // written through to the local mirror so the member list and the seat
    // count read the change without waiting for the Events reconciler.
    const mirror = yield* WorkOsMirror;
    // Membership READS come from the mirror through the shared directory: the
    // admin gate, the member list and the seat count are one local query
    // each, never a WorkOS read.
    const directory = yield* MemberDirectory;

    // The caller, resolved once per request by the cookie-only session
    // middleware (account-api.ts) — the same credential `SessionAuthLive`
    // accepts. The method bodies read the already-authenticated session rather
    // than re-parsing the cookie. `null` => no/invalid session.
    const caller = yield* AccountCaller;

    // Capture the resolved service context once so the method bodies — which
    // call `authorizeOrganization` (yields `MemberDirectory` + `UserStoreService`
    // + `WorkOSClient`), the mirror feeders, and the seat reporter — can be
    // erased to `R = never`, as the neutral AccountProvider shape requires.
    // Provided per method below.
    const ctx = yield* Effect.context<
      WorkOSClient | UserStoreService | AutumnService | MemberDirectory | WorkOsMirror
    >();

    // Unauthenticated (missing/invalid session) => AccountUnauthorized, exactly
    // as the old inline `requireSession` did.
    const requireSession = () =>
      caller.session
        ? Effect.succeed(caller.session)
        : Effect.fail<AccountUnauthorized>(new AccountUnauthorized());

    // The org scope for an org-scoped request: the console URL's org, sent in
    // the selector header. FAIL CLOSED when it's missing — the session's own
    // org is a browser-global pinned to whichever org WorkOS last touched, so
    // falling back to it scopes a multi-org user's request to the WRONG org
    // (see workos-auth-provider.resolveSessionPrincipal). Membership is
    // re-checked against the mirror, so the header is a selector, not a trust
    // boundary — and two browser tabs on different orgs each send their own header, so
    // they stay independent (see organization.ts). Yields the session +
    // resolved org (carrying the caller's `memberRole` from that same
    // membership read), or AccountNoOrganization.
    const requireOrganization = (headers: AccountHeaders) =>
      Effect.gen(function* () {
        const session = yield* requireSession();
        const selector = headers[ORG_SELECTOR_HEADER];
        if (!selector) {
          return yield* new AccountNoOrganization();
        }
        const org = yield* authorizeOrganizationSelector(session.accountId, selector).pipe(
          Effect.provideContext(ctx),
          Effect.mapError(() => new AccountNoOrganization()),
        );
        if (!org) return yield* new AccountNoOrganization();
        return { session, org };
      });

    // Mirror of org/handlers `requireAdmin`, but scoped to the resolved org.
    // `authorizeOrganization` already read the caller's mirrored membership,
    // required it to be ACTIVE, and normalized its role into `memberRole` —
    // so the gate is that one value, not a second read of the same row. A
    // pending admin invite is not an admin, and a member removed or demoted
    // moments ago is denied as soon as the write-through or the Events
    // reconciler has landed the change.
    const requireAdmin = (org: { readonly memberRole: "admin" | "member" }) =>
      Effect.gen(function* () {
        if (org.memberRole !== "admin") return yield* new AccountForbidden();
        const session = yield* requireSession();
        if (session.adminVerified !== true) {
          return yield* new AccountForbidden({
            message: "Verify your identity to use organization admin settings.",
          });
        }
      });

    // Ownership check so an admin can't mutate a membership id from another
    // org: the id must name a row the mirror holds for THIS org (any status —
    // revoking a pending invite is a delete too). One point read on the
    // membership id, scoped to the org: the member list the admin acted from
    // is read from the same mirror, so every id it shows resolves here; a
    // foreign or unknown id does not. A read failure is the same 500 as the
    // admin gate's, never a refusal dressed up as "not yours".
    const assertMembershipInOrg = (organizationId: string, membershipId: string) =>
      Effect.gen(function* () {
        const membership = yield* directory
          .membershipById(organizationId, membershipId)
          .pipe(Effect.catchTag("MemberDirectoryError", toAccountError));
        if (!membership) {
          return yield* new AccountForbidden();
        }
        return membership;
      });

    // Seat usage: memberships from the local directory (active + pending, the
    // `members` default), pending invitations live from WorkOS — invitations
    // are not mirrored. The directory is trusted for a COUNT only once this
    // organization's membership list has been scanned from WorkOS in full:
    // login and write-through record single memberships, so an organization
    // the one-off backfill did not cover holds a partial list, and counting
    // it would admit invitations past the plan limit. The scan runs here,
    // once, when the organization's mark is missing.
    const getMemberSeats = (organizationId: string) =>
      Effect.gen(function* () {
        const customer = yield* autumn.use((client) =>
          client.customers.getOrCreate({ customerId: organizationId }),
        );
        const planId = selectActiveMemberLimitPlan(customer.subscriptions);
        const limit = getMemberLimitForPlan(planId);

        yield* ensureOrganizationBackfilled(organizationId).pipe(Effect.provideContext(ctx));
        // The directory reports active members AND pending memberships (an
        // invited user is mirrored with status "pending"); `listPendingInvitations`
        // returns the same invited users again. `countSeatsUsed` dedupes them
        // so an outstanding invite is not counted twice.
        const memberships = yield* directory.members(organizationId);
        const invitations = yield* workos.listPendingInvitations(organizationId);

        return {
          used: countSeatsUsed(memberships, invitations.data.length),
          granted: limit ?? 0,
          unlimited: limit === null,
        };
      });

    // Mirror of org/handlers `reserveMemberSlot` — fail closed on lookup error.
    const reserveMemberSlot = (organizationId: string) =>
      Effect.gen(function* () {
        const seats = yield* getMemberSeats(organizationId).pipe(
          Effect.catchCause(() => Effect.fail(new AccountForbidden())),
        );
        if (!seats.unlimited && seats.used >= seats.granted) {
          // Name the real reason so the UI can tell the admin this is a plan
          // limit (retrying will not help), not a transient failure. The
          // fail-closed lookup error above stays message-less (genuinely
          // retryable), so only the cap hit carries this copy.
          const plural = seats.granted === 1 ? "member" : "members";
          return yield* new AccountForbidden({
            message: `Your plan includes ${seats.granted} ${plural}. Upgrade your plan to invite more.`,
          });
        }
      });

    return AccountProvider.of({
      me: (headers) =>
        Effect.gen(function* () {
          const session = yield* requireSession();
          // The ONE sanctioned fallback to the session org. /account/me is
          // identity, not tenant data: on a bare URL (no org slug yet, so no
          // header) it answers "which org should this browser land in", and
          // the session's pinned org is the only candidate. Every org-scoped
          // DATA read fails closed instead (requireOrganization above,
          // resolveSessionPrincipal) — serving tenant data from this fallback
          // is exactly the wrong-org connection-list bug (2026-07). With a
          // header (any slugged URL), the URL's org drives the answer so the
          // shell reflects the org the tab is viewing.
          const selector = headers[ORG_SELECTOR_HEADER] ?? session.organizationId;
          const org = selector
            ? yield* authorizeOrganizationSelector(session.accountId, selector).pipe(
                Effect.provideContext(ctx),
                Effect.orElseSucceed(() => null),
              )
            : null;
          return {
            user: {
              id: session.accountId,
              email: session.email,
              name: session.name,
              avatarUrl: session.avatarUrl,
            },
            organization: org ? { id: org.id, name: org.name, slug: org.slug } : null,
          };
        }),

      listApiKeys: (headers) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization(headers);
          const keys = yield* apiKeys
            .listUserKeys({
              accountId: session.accountId,
              organizationId: org.id,
            })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          return { apiKeys: keys };
        }),

      createApiKey: (headers, name) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization(headers);
          // An admin's personal key inherits workspace write permission.
          // Do not let an unverified browser session mint that credential.
          if (org.memberRole === "admin") yield* requireAdmin(org);
          const trimmed = name.trim().slice(0, MAX_API_KEY_NAME_LENGTH);
          if (!trimmed) {
            return yield* new AccountError({
              message: "API key name is required",
            });
          }
          return yield* apiKeys
            .createUserKey({
              accountId: session.accountId,
              organizationId: org.id,
              name: trimmed,
            })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
        }),

      revokeApiKey: (headers, apiKeyId) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization(headers);
          const ownedKeys = yield* apiKeys
            .listUserKeys({
              accountId: session.accountId,
              organizationId: org.id,
            })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          if (!ownedKeys.some((key) => key.id === apiKeyId)) {
            return yield* new AccountError({ message: "API key not found" });
          }
          yield* apiKeys
            .revokeUserKey({ keyId: apiKeyId })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          return { success: true };
        }),

      // Org keys read every user in the tenant through the `/admin/*` plane, so
      // both paths are admin-gated — unlike personal keys, which any member may
      // mint for themselves.
      listOrgApiKeys: (headers) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          const keys = yield* apiKeys
            .listOrgKeys({ organizationId: org.id })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          return { apiKeys: keys };
        }),

      createOrgApiKey: (headers, name) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          const trimmed = name.trim().slice(0, MAX_API_KEY_NAME_LENGTH);
          if (!trimmed) {
            return yield* new AccountError({
              message: "API key name is required",
            });
          }
          return yield* apiKeys
            .createOrgKey({ organizationId: org.id, name: trimmed })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
        }),

      // Same admin gate as the mint. Note this deliberately does NOT reuse
      // `revokeApiKey`: that path resolves ownership against the caller's
      // personal keys, so an org key id is never in its owned set. Ownership
      // here is resolved against the ORG's keys inside `revokeOrgKey`, which is
      // what keeps a user-scoped (or foreign-org) key id from being destroyed
      // through the org route — it surfaces as a 404-shaped AccountError, not a
      // silent success and not a 500.
      revokeOrgApiKey: (headers, apiKeyId) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          yield* apiKeys.revokeOrgKey({ organizationId: org.id, keyId: apiKeyId }).pipe(
            Effect.catchTag("ApiKeyManagementError", toAccountError),
            Effect.catchTag("OrgApiKeyNotFound", () =>
              Effect.fail(
                new AccountError({
                  message: "Organization API key not found",
                }),
              ),
            ),
          );
          return { success: true };
        }),

      listMembers: (headers) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization(headers);

          // Seats fall back to safe display defaults on lookup error — never
          // blank the page over a transient Autumn/WorkOS hiccup. The real cap
          // gate lives in `reserveMemberSlot`, which fails closed.
          const seats = yield* getMemberSeats(org.id).pipe(
            Effect.catchCause(() => Effect.succeed({ used: 0, granted: 0, unlimited: false })),
          );

          // One directory read (active + pending, ordered by email) with the
          // profile already joined — no per-member WorkOS user fetch.
          const directoryMembers = yield* directory
            .members(org.id)
            .pipe(Effect.catchTag("MemberDirectoryError", toAccountError));

          const members = directoryMembers.map((m) => ({
            id: m.membershipId,
            userId: m.accountId,
            email: m.email,
            name: m.name,
            avatarUrl: m.avatarUrl,
            role: m.role,
            status: m.status,
            lastActiveAt: m.lastActiveAt === null ? null : new Date(m.lastActiveAt).toISOString(),
            isCurrentUser: m.accountId === session.accountId,
          }));

          return { members, seats };
        }),

      listRoles: (headers) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          const result = yield* workos
            .listOrgRoles(org.id)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          return {
            roles: result.data.map((r) => ({ slug: r.slug, name: r.name })),
          };
        }),

      inviteMember: (headers, body) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          yield* reserveMemberSlot(org.id);
          const invitation = yield* workos
            .sendInvitation({
              email: body.email,
              organizationId: org.id,
              ...(body.roleSlug ? { roleSlug: body.roleSlug } : {}),
            })
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          // Write-through: WorkOS creates a PENDING membership for the invitee
          // alongside the invitation, and the member list (the "Invited" row
          // and its revoke button) reads memberships from the mirror only, so
          // the row must land now — the Events reconciler is not on this path.
          const mirrored = yield* mirrorInvitedMember(org.id, invitation.email).pipe(
            Effect.provideContext(ctx),
            Effect.catchTags({
              WorkOSError: toAccountError,
              WorkOsMirrorError: toAccountError,
            }),
          );
          if (!mirrored) {
            yield* Effect.logWarning("inviteMember: no pending membership for the invitee yet", {
              organizationId: org.id,
              invitationId: invitation.id,
            });
          }
          return { id: invitation.id, email: invitation.email };
        }),

      removeMember: (headers, membershipId) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          const membership = yield* assertMembershipInOrg(org.id, membershipId);
          yield* workos
            .deleteOrgMembership(membershipId)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          // Tombstoned by identity: the deleted WorkOS id never returns, so
          // a login or backfill that fetched this membership before the
          // delete — or a role change issued before it and delivered after
          // — is refused however it is stamped, while a replacement
          // membership WorkOS creates for the same member (a new id) is
          // not. No WorkOS instant is in hand (`null`: WorkOS answers a
          // delete with no time, and the row was read from the mirror): the
          // row keeps its own stamp, never the local clock, which read
          // after WorkOS answered could post-date that replacement.
          yield* mirror
            .deleteMembership(
              {
                id: membershipId,
                accountId: membership.accountId,
                organizationId: membership.organizationId,
              },
              null,
            )
            .pipe(Effect.catchTag("WorkOsMirrorError", toAccountError));
          yield* forkReportMemberSeats(org.id).pipe(Effect.provideContext(ctx));
          return { success: true };
        }),

      updateMemberRole: (headers, membershipId, roleSlug) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          yield* assertMembershipInOrg(org.id, membershipId);
          const updated = yield* workos
            .updateOrgMembershipRole(membershipId, roleSlug)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          yield* mirror
            .upsertMembership(mirrorMembershipFromWorkOs(updated))
            .pipe(Effect.catchTag("WorkOsMirrorError", toAccountError));
          return { success: true };
        }),

      updateOrgName: (headers, name) =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization(headers);
          yield* requireAdmin(org);
          const updated = yield* workos
            .updateOrganization(org.id, name)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          yield* users
            .use("upsertOrganization", (s) =>
              s.upsertOrganization({
                id: updated.id,
                name: updated.name,
                updatedAt: new Date(updated.updatedAt),
              }),
            )
            .pipe(Effect.catchTag("UserStoreError", toAccountError));
          return { name: updated.name };
        }),
    } satisfies AccountProvider["Service"]);
  }),
);
