import { Context, Effect, Layer } from "effect";

import { AccountProvider } from "@executor-js/api/server";
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
import { authorizeOrganization } from "../auth/organization";
import { AutumnService } from "../services/autumn";
import { getMemberLimitForPlan, selectActiveMemberLimitPlan } from "../services/autumn-plans";

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
//   WorkOSError | UserStoreError | ApiKeyManagementError → AccountError
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
  WorkOSClient | UserStoreService | ApiKeyService | AutumnService | AccountCaller
> = Layer.effect(AccountProvider)(
  Effect.gen(function* () {
    const workos = yield* WorkOSClient;
    const apiKeys = yield* ApiKeyService;
    const autumn = yield* AutumnService;
    const users = yield* UserStoreService;

    // The caller, resolved once per request by the cookie-only session
    // middleware (account-api.ts) — the same credential `SessionAuthLive`
    // accepts. The method bodies read the already-authenticated session rather
    // than re-parsing the cookie. `null` => no/invalid session.
    const caller = yield* AccountCaller;

    // Capture the resolved service context once so the method bodies — which
    // call `authorizeOrganization` (yields `WorkOSClient` + `UserStoreService`) —
    // can be erased to `R = never`, as the neutral AccountProvider shape
    // requires. Provided per method below.
    const ctx = yield* Effect.context<WorkOSClient | UserStoreService>();

    // Unauthenticated (missing/invalid session) => AccountUnauthorized, exactly
    // as the old inline `requireSession` did.
    const requireSession = () =>
      caller.session
        ? Effect.succeed(caller.session)
        : Effect.fail<AccountUnauthorized>(new AccountUnauthorized());

    // Like cloud's `requireSessionOrganization`: an authenticated session that
    // currently holds an active membership in its session org. Yields the
    // session + resolved org, or AccountNoOrganization.
    const requireOrganization = () =>
      Effect.gen(function* () {
        const session = yield* requireSession();
        if (!session.organizationId) {
          return yield* new AccountNoOrganization();
        }
        const org = yield* authorizeOrganization(session.accountId, session.organizationId).pipe(
          Effect.provideContext(ctx),
          Effect.mapError(() => new AccountNoOrganization()),
        );
        if (!org) return yield* new AccountNoOrganization();
        return { session, org };
      });

    // Mirror of org/handlers `requireAdmin`, but scoped to the resolved org.
    const requireAdmin = (accountId: string, organizationId: string) =>
      Effect.gen(function* () {
        const membership = yield* workos
          .getUserOrgMembership(organizationId, accountId)
          .pipe(Effect.catchTag("WorkOSError", toAccountError));
        if (!membership || membership.role?.slug !== "admin") {
          return yield* new AccountForbidden();
        }
      });

    // Mirror of org/handlers `assertMembershipInSessionOrg` — ownership check so
    // an admin can't mutate a membership id from another org.
    const assertMembershipInOrg = (organizationId: string, membershipId: string) =>
      Effect.gen(function* () {
        const membership = yield* workos
          .getOrgMembership(membershipId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (!membership || membership.organizationId !== organizationId) {
          return yield* new AccountForbidden();
        }
      });

    // Mirror of org/handlers `getMemberSeats` — live seat usage from WorkOS.
    const getMemberSeats = (organizationId: string) =>
      Effect.gen(function* () {
        const customer = yield* autumn.use((client) =>
          client.customers.getOrCreate({ customerId: organizationId }),
        );
        const planId = selectActiveMemberLimitPlan(customer.subscriptions);
        const limit = getMemberLimitForPlan(planId);

        const memberships = yield* workos.listOrgMembers(organizationId);
        const invitations = yield* workos.listPendingInvitations(organizationId);

        return {
          used: memberships.data.length + invitations.data.length,
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
          return yield* new AccountForbidden();
        }
      });

    return AccountProvider.of({
      me: () =>
        Effect.gen(function* () {
          const session = yield* requireSession();
          const org = session.organizationId
            ? yield* authorizeOrganization(session.accountId, session.organizationId).pipe(
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
            organization: org ? { id: org.id, name: org.name } : null,
          };
        }),

      listApiKeys: () =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          const keys = yield* apiKeys
            .listUserKeys({ accountId: session.accountId, organizationId: org.id })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          return { apiKeys: keys };
        }),

      createApiKey: (_headers, name) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          const trimmed = name.trim().slice(0, MAX_API_KEY_NAME_LENGTH);
          if (!trimmed) {
            return yield* new AccountError({ message: "API key name is required" });
          }
          return yield* apiKeys
            .createUserKey({ accountId: session.accountId, organizationId: org.id, name: trimmed })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
        }),

      revokeApiKey: (_headers, apiKeyId) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          const ownedKeys = yield* apiKeys
            .listUserKeys({ accountId: session.accountId, organizationId: org.id })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          if (!ownedKeys.some((key) => key.id === apiKeyId)) {
            return yield* new AccountError({ message: "API key not found" });
          }
          yield* apiKeys
            .revokeUserKey({ keyId: apiKeyId })
            .pipe(Effect.catchTag("ApiKeyManagementError", toAccountError));
          return { success: true };
        }),

      listMembers: () =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();

          // Seats fall back to safe display defaults on lookup error — never
          // blank the page over a transient Autumn/WorkOS hiccup. The real cap
          // gate lives in `reserveMemberSlot`, which fails closed.
          const seats = yield* getMemberSeats(org.id).pipe(
            Effect.catchCause(() => Effect.succeed({ used: 0, granted: 0, unlimited: false })),
          );

          const memberships = yield* workos
            .listOrgMembers(org.id)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));

          const members = yield* Effect.all(
            memberships.data.map((m) =>
              Effect.gen(function* () {
                const user = yield* workos.getUser(m.userId);
                return {
                  id: m.id,
                  userId: m.userId,
                  email: user.email,
                  name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
                  avatarUrl: user.profilePictureUrl ?? null,
                  role: m.role?.slug ?? "member",
                  status: m.status,
                  lastActiveAt: user.lastSignInAt ?? null,
                  isCurrentUser: m.userId === session.accountId,
                };
              }),
            ),
            { concurrency: 5 },
          ).pipe(Effect.catchTag("WorkOSError", toAccountError));

          return { members, seats };
        }),

      listRoles: () =>
        Effect.gen(function* () {
          const { org } = yield* requireOrganization();
          const result = yield* workos
            .listOrgRoles(org.id)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          return {
            roles: result.data.map((r) => ({ slug: r.slug, name: r.name })),
          };
        }),

      inviteMember: (_headers, body) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          yield* requireAdmin(session.accountId, org.id);
          yield* reserveMemberSlot(org.id);
          const invitation = yield* workos
            .sendInvitation({
              email: body.email,
              organizationId: org.id,
              ...(body.roleSlug ? { roleSlug: body.roleSlug } : {}),
            })
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          return { id: invitation.id, email: invitation.email };
        }),

      removeMember: (_headers, membershipId) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          yield* requireAdmin(session.accountId, org.id);
          yield* assertMembershipInOrg(org.id, membershipId);
          yield* workos
            .deleteOrgMembership(membershipId)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          return { success: true };
        }),

      updateMemberRole: (_headers, membershipId, roleSlug) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          yield* requireAdmin(session.accountId, org.id);
          yield* assertMembershipInOrg(org.id, membershipId);
          yield* workos
            .updateOrgMembershipRole(membershipId, roleSlug)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          return { success: true };
        }),

      updateOrgName: (_headers, name) =>
        Effect.gen(function* () {
          const { session, org } = yield* requireOrganization();
          yield* requireAdmin(session.accountId, org.id);
          const updated = yield* workos
            .updateOrganization(org.id, name)
            .pipe(Effect.catchTag("WorkOSError", toAccountError));
          yield* users
            .use((s) => s.upsertOrganization({ id: updated.id, name: updated.name }))
            .pipe(Effect.catchTag("UserStoreError", toAccountError));
          return { name: updated.name };
        }),
    } satisfies AccountProvider["Service"]);
  }),
);
