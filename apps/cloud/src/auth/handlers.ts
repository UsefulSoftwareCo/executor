import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Clock, Duration, Effect, Predicate } from "effect";
import { isValidOrgSlug } from "@executor-js/api";

import {
  AUTH_PATHS,
  CloudAuthApi,
  CloudAuthPublicApi,
  McpExecutionNotFoundError,
  McpSessionForbiddenError,
  OrganizationDeletionForbidden,
  OrganizationDeletionIncomplete,
} from "./api";
import { MemberDirectory, NoOrganization } from "@executor-js/api/server";
// Pure constants/codec module (no React) — safe in the backend graph.
import { AUTH_HINT_COOKIE } from "@executor-js/react/multiplayer/auth-hint";
import { SessionContext, SessionCookies } from "./middleware";
import { encodeLoginState, decodeLoginState } from "./login-state";
import { safeReturnTo } from "./return-to";
import { UserStoreService } from "./context";
import { mirrorMembership, mirrorSignIn } from "./mirror-feeders";
import { env } from "cloudflare:workers";
import { WorkOSError } from "./errors";
import { WorkOSClient } from "./workos";
import { AutumnService, autumnStatusOf } from "../extensions/billing/service";
import { forkReportMemberSeats } from "../extensions/billing/member-seats";
import { captureCauseEffect } from "../observability";
import {
  hasPaidOrganizationSubscription,
  isOverFreeOrganizationLimit,
  shouldApplyFreeOrganizationLimit,
} from "../extensions/billing/plans";
import { LAST_ORG_COOKIE } from "./last-org-cookie";
import {
  ORG_SELECTOR_HEADER,
  authorizeOrganization,
  authorizeOrganizationSelector,
  markOrganizationDeleted,
  resolveOrganization,
  type AuthorizeOrganizationOptions,
} from "./organization";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 7,
  secure: true,
};

const STATE_COOKIE = "wos-login-state";
const STATE_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 10 * 60,
  secure: true,
};

const RESPONSE_COOKIE_OPTIONS = {
  ...COOKIE_OPTIONS,
  maxAge: Duration.days(7),
};

const RESPONSE_STATE_COOKIE_OPTIONS = {
  ...STATE_COOKIE_OPTIONS,
  maxAge: Duration.minutes(10),
};

const DELETE_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 0,
  expires: new Date(0),
  secure: true,
};

const randomNonce = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const requestHeaders = Effect.map(HttpServerRequest.HttpServerRequest.asEffect(), (req) => ({
  ...req.headers,
}));

const firstPathSegment = (path: string): string | null => {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  const segment = pathname.split("/")[1];
  return segment && isValidOrgSlug(segment) ? segment : null;
};

const requestedOrgSelectorFromReturnTo = (returnTo: string): string | null =>
  firstPathSegment(returnTo);

const selectedOrganization = (options: AuthorizeOrganizationOptions = {}) =>
  Effect.gen(function* () {
    const session = yield* SessionContext;
    const headers = yield* requestHeaders;
    const selector = headers[ORG_SELECTOR_HEADER] ?? session.organizationId;
    if (!selector) {
      return yield* new NoOrganization();
    }

    const org = yield* authorizeOrganizationSelector(session.accountId, selector, options).pipe(
      Effect.catch(() => Effect.fail(new NoOrganization())),
    );
    if (!org) {
      return yield* new NoOrganization();
    }

    return {
      ...session,
      organizationId: org.id,
      memberRole: org.memberRole,
    };
  });

const requireSelectedOrganization = selectedOrganization();

const getMcpSessionStub = (mcpSessionId: string) => mcpSessionStub(env.MCP_SESSION, mcpSessionId);

const failMcpApprovalResult = (
  result: { readonly status: "not_found" | "forbidden" },
  params: { readonly mcpSessionId: string; readonly executionId: string },
) => {
  if (result.status === "forbidden") {
    return Effect.fail(new McpSessionForbiddenError({ mcpSessionId: params.mcpSessionId }));
  }
  return Effect.fail(new McpExecutionNotFoundError({ executionId: params.executionId }));
};

const setResponseCookie = (
  response: HttpServerResponse.HttpServerResponse,
  name: string,
  value: string,
  options: typeof RESPONSE_COOKIE_OPTIONS,
) => HttpServerResponse.setCookieUnsafe(response, name, value, options);

const deleteResponseCookie = (response: HttpServerResponse.HttpServerResponse, name: string) =>
  HttpServerResponse.setCookieUnsafe(response, name, "", DELETE_COOKIE_OPTIONS);

// ---------------------------------------------------------------------------
// Single non-protected API surface — public (login/callback/logout) + session
// (me/organizations/switch-organization). The session group has SessionAuth on it.
// ---------------------------------------------------------------------------

export const NonProtectedApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi).add(CloudAuthApi);

// ---------------------------------------------------------------------------
// Public auth handlers (no authentication required)
// ---------------------------------------------------------------------------

export const CloudAuthPublicHandlers = HttpApiBuilder.group(
  NonProtectedApi,
  "cloudAuthPublic",
  (handlers) =>
    handlers
      .handleRaw("login", ({ query }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          // Use the explicit public site URL — in dev, the request's Host
          // header points at the internal proxy target, not the public URL
          // WorkOS needs to redirect back to.
          const origin = env.VITE_PUBLIC_SITE_URL ?? "";
          // OAuth round-trips `state` verbatim, so the validated returnTo
          // rides inside it next to the CSRF nonce — no extra cookie.
          const state = encodeLoginState({
            nonce: randomNonce(),
            returnTo: safeReturnTo(query.returnTo) ?? undefined,
          });
          const url = workos.getAuthorizationUrl(`${origin}${AUTH_PATHS.callback}`, state);
          return setResponseCookie(
            HttpServerResponse.redirect(url, { status: 302 }),
            STATE_COOKIE,
            state,
            RESPONSE_STATE_COOKIE_OPTIONS,
          );
        }),
      )
      .handleRaw("callback", ({ request, query }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          const users = yield* UserStoreService;
          // Hosted invitations can start at WorkOS without app-issued state.
          // Discard that unbound code and start a fresh browser-bound login.
          // Exchanging it here would allow login CSRF.
          if (query.state === undefined) {
            return deleteResponseCookie(
              HttpServerResponse.redirect(AUTH_PATHS.login, { status: 302 }),
              STATE_COOKIE,
            );
          }

          const cookieState = request.cookies[STATE_COOKIE] ?? null;
          // Only exchange codes bound to the state cookie set on /login.
          if (!cookieState || !timingSafeEqual(cookieState, query.state)) {
            return deleteResponseCookie(
              HttpServerResponse.text("Invalid login state", { status: 400 }),
              STATE_COOKIE,
            );
          }

          const result = yield* workos.authenticateWithCode(query.code);

          // ONE membership list for the whole callback. It feeds the mirror
          // (the user + every org they hold a membership in, all already in
          // hand) and it is the membership check for every landing-org
          // candidate below, so the callback makes no per-candidate WorkOS
          // call. The user's account row is minted by the mirror's user
          // upsert. The list's fetch instant, taken before the read, stamps
          // the organization names it carries (see `mirrorSignIn`).
          const fetchedAt = new Date(yield* Clock.currentTimeMillis);
          const memberships = yield* workos.listUserMemberships(result.user.id);
          yield* mirrorSignIn(result.user, memberships.data, fetchedAt);

          let sealedSession = result.sealedSession;

          // Resume where the SSR gate interrupted them. The state passed the
          // CSRF check above, but it's still a
          // round-tripped value, so the returnTo inside it is re-validated like
          // any other untrusted path.
          const returnTo = safeReturnTo(decodeLoginState(query.state)?.returnTo) ?? "/";
          const requestedOrgSelector = requestedOrgSelectorFromReturnTo(returnTo);

          // An org SLUG (both candidate sources below are slug-validated, so
          // an `org_…` id never reaches here) resolves to its id only when the
          // list above holds an ACTIVE membership in it. Pending memberships
          // are skipped because refreshing into one 400s and would bypass
          // invite consent. A slug that fails to resolve (unknown, or a store
          // hiccup) is not a candidate, the same as an org the user is not in.
          const activeOrganizationIds = new Set(
            memberships.data.filter((m) => m.status === "active").map((m) => m.organizationId),
          );
          const activeOrganizationFor = (slug: string) =>
            users
              .use("getOrganizationBySlug", (s) => s.getOrganizationBySlug(slug))
              .pipe(
                Effect.map((org) => (org && activeOrganizationIds.has(org.id) ? org.id : null)),
                Effect.orElseSucceed(() => null),
              );

          // Prefer the org in the URL that sent the user to login. If the URL
          // is bare, or not an org route, prefer the org this browser last
          // worked in (the last-org cookie — it outlives the session precisely
          // so a fresh login lands where the user left off), then WorkOS's
          // org, then the first active membership for org-less sessions.
          // The cookie is membership-checked like any selector, so a stale
          // one just falls through.
          let targetOrganizationId = requestedOrgSelector
            ? yield* activeOrganizationFor(requestedOrgSelector)
            : null;
          if (!targetOrganizationId && !requestedOrgSelector) {
            const lastOrgSlug = request.cookies[LAST_ORG_COOKIE];
            targetOrganizationId =
              lastOrgSlug && isValidOrgSlug(lastOrgSlug)
                ? yield* activeOrganizationFor(lastOrgSlug)
                : null;
          }
          targetOrganizationId ??= result.organizationId ?? null;
          if (!targetOrganizationId && !requestedOrgSelector) {
            const existingActive = memberships.data.find((m) => m.status === "active");
            targetOrganizationId = existingActive?.organizationId ?? null;
          }

          // Seat changes the app never sees a mutation for (invitation
          // acceptance in AuthKit, SSO JIT provisioning, join by domain,
          // WorkOS dashboard edits) all end in a sign-in, so every login
          // reconciles the landed org's billed seat count. Forked: billing
          // must not delay the login.
          if (targetOrganizationId) {
            yield* forkReportMemberSeats(targetOrganizationId);
          }

          if (
            targetOrganizationId &&
            targetOrganizationId !== result.organizationId &&
            sealedSession
          ) {
            // Best-effort refresh: if WorkOS rejects, fall through with the
            // original session instead of 500ing the entire callback.
            const refreshed = yield* workos
              .refreshSession(sealedSession, targetOrganizationId)
              .pipe(Effect.orElseSucceed(() => null));
            if (refreshed) sealedSession = refreshed;
          }

          if (!sealedSession) {
            return HttpServerResponse.text("Failed to create session", {
              status: 500,
            });
          }

          return deleteResponseCookie(
            setResponseCookie(
              HttpServerResponse.redirect(returnTo, { status: 302 }),
              "wos-session",
              sealedSession,
              RESPONSE_COOKIE_OPTIONS,
            ),
            STATE_COOKIE,
          );
        }),
      )
      .handleRaw("logout", ({ request }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          // The session this browser presents, NOT one the middleware vouched
          // for — signing out of a session that has already ended must still
          // sign the browser out (see the group declaration in ./api.ts).
          const sealedSession = request.cookies["wos-session"] ?? "";

          // WorkOS's documented sign-out: send the browser through the WorkOS
          // logout endpoint, which ends the AuthKit session upstream and then
          // redirects to the registered sign-out URL. Without this hop, the
          // hosted session survives and the next "Sign in" silently
          // re-authenticates (issue #1445). Fail-open when the cookie won't
          // unseal — there is then nothing to end upstream, and local sign-out
          // must still complete, so fall back to "/".
          const origin = env.VITE_PUBLIC_SITE_URL ?? "";
          const logoutUrl = sealedSession
            ? yield* workos.logoutUrl(sealedSession, origin ? `${origin}/` : undefined)
            : null;

          const response = HttpServerResponse.redirect(logoutUrl ?? "/", {
            status: 302,
          });

          // Drop only what this browser actually presented. Both cookies are
          // SameSite=Lax, so a cross-site form POST carries neither — it gets
          // the bare redirect and cannot be used to sign anyone out.
          if (!sealedSession && request.cookies[AUTH_HINT_COOKIE] === undefined) return response;

          // The auth-hint travels with the session: leaving it behind would
          // make the next page load optimistically paint the app shell for a
          // signed-out browser.
          return deleteResponseCookie(
            deleteResponseCookie(
              HttpServerResponse.setHeader(response, "Clear-Site-Data", '"cache", "storage"'),
              "wos-session",
            ),
            AUTH_HINT_COOKIE,
          );
        }),
      )
      // CLI device-login discovery. The WorkOS device endpoints live on the
      // WorkOS API host (`WORKOS_API_URL`, or api.workos.com in production,
      // the SAME base the SDK uses, so e2e points the CLI at the emulator with
      // zero extra wiring). The CLI runs RFC 8628 against them as a public
      // client (no secret) and gets a WorkOS access-token JWT back.
      .handle("cliLogin", () =>
        Effect.sync(() => {
          const base = (env.WORKOS_API_URL ?? "https://api.workos.com").replace(/\/+$/, "");
          return {
            provider: "workos" as const,
            deviceAuthorizationEndpoint: `${base}/user_management/authorize/device`,
            tokenEndpoint: `${base}/user_management/authenticate`,
            clientId: env.WORKOS_CLIENT_ID,
          };
        }),
      ),
);

// ---------------------------------------------------------------------------
// Session auth handlers (require session, may or may not have an org)
// ---------------------------------------------------------------------------

export const CloudSessionAuthHandlers = HttpApiBuilder.group(
  NonProtectedApi,
  "cloudAuth",
  (handlers) =>
    handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const session = yield* SessionContext;
          const org = session.organizationId
            ? yield* authorizeOrganization(session.accountId, session.organizationId)
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
      )
      .handle("organizations", () =>
        Effect.gen(function* () {
          const directory = yield* MemberDirectory;
          const session = yield* SessionContext;

          // The caller's memberships (active + pending, as WorkOS listed them
          // before) from the local mirror — one indexed read, no WorkOS call.
          const memberships = yield* directory.membershipsOf(session.accountId);
          // Resolve through the mirror (not WorkOS directly) so each org's
          // URL slug is minted/read — the switcher navigates to `/<slug>`.
          // An org marked deleted (its deletion is in progress or failed
          // part-way, see deleteOrganization) refuses every session, so it
          // is not a place the switcher can go.
          const organizations = yield* Effect.all(
            memberships.map((m) =>
              resolveOrganization(m.organizationId).pipe(
                Effect.map((org) =>
                  org.deletedAt === null
                    ? {
                        id: org.id,
                        name: org.name,
                        slug: org.slug,
                      }
                    : null,
                ),
                Effect.orElseSucceed(() => null),
              ),
            ),
            { concurrency: "unbounded" },
          );

          return {
            organizations: organizations.filter(Predicate.isNotNull),
            activeOrganizationId: session.organizationId,
          };
        }),
      )
      .handle("createOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          const users = yield* UserStoreService;
          const session = yield* SessionContext;
          const autumn = yield* AutumnService;

          const name = payload.name.trim();
          // The free-organizations-per-user limit counts the caller's ACTIVE
          // memberships, read from the local mirror.
          const directory = yield* MemberDirectory;
          const activeMemberships = yield* directory.membershipsOf(session.accountId, ["active"]);

          if (isOverFreeOrganizationLimit(activeMemberships)) {
            const paidOrganizationIds = yield* Effect.all(
              activeMemberships.map((membership) =>
                autumn
                  .use((client) =>
                    client.customers.getOrCreate({
                      customerId: membership.organizationId,
                    }),
                  )
                  .pipe(
                    Effect.map((customer) =>
                      hasPaidOrganizationSubscription(customer.subscriptions)
                        ? membership.organizationId
                        : null,
                    ),
                  ),
              ),
              { concurrency: 3 },
            ).pipe(
              // Any Autumn failure here (outage or missing customer) leaves the
              // paid/free split unknown, and the limit must fail closed.
              Effect.mapError(() => new WorkOSError()),
              Effect.map((ids) => new Set(ids.filter(Predicate.isNotNull))),
            );

            if (shouldApplyFreeOrganizationLimit(activeMemberships, paidOrganizationIds)) {
              return yield* new WorkOSError();
            }
          }

          const org = yield* workos.createOrganization(name);
          const membership = yield* workos.createMembership(org.id, session.accountId, "admin");
          // `upsertOrganization` mints the slug at insert — no separate heal step.
          const mirrored = yield* users.use("upsertOrganization", (s) =>
            s.upsertOrganization({
              id: org.id,
              name: org.name,
              updatedAt: new Date(org.updatedAt),
            }),
          );
          // Write-through: the creator's admin membership, from the create
          // response, lands in the mirror before anything reads it.
          yield* mirrorMembership(membership);

          // Provision the org's billing customer while we're the ones creating
          // the org. Without this the first billing call an org ever makes is a
          // non-creating one (balance check / usage track), which 404s and keeps
          // 404ing — unlimited unbilled executions. Non-fatal: a billing blip
          // must not block signup, and the billing seam heals a customer that
          // is still missing later.
          yield* autumn.ensureCustomer(org.id).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "createOrganization: could not provision the Autumn customer",
                  { organizationId: org.id, error },
                );
                yield* captureCauseEffect(error);
              }),
            ),
          );
          // Seed the new org's billed seat count (the creator's seat).
          yield* forkReportMemberSeats(org.id);

          // Try to attach the new org to the current session. This can fail
          // (or silently return a session still scoped to the old org) when
          // the caller's current session is stale — most commonly after the
          // user was removed from the org their cookie is pinned to. In that
          // case we can't repair the session in-place, so we clear the
          // cookie and fail loudly; the frontend will bounce to login and
          // the callback's rehydrate path will pick up the new membership.
          const refreshed = yield* workos.refreshSession(session.sealedSession, org.id);
          const verified = refreshed ? yield* workos.authenticateSealedSession(refreshed) : null;

          if (!refreshed || !verified || verified.organizationId !== org.id) {
            yield* Effect.logWarning(
              "createOrganization: unable to attach new org to current session",
              {
                userId: session.accountId,
                newOrgId: org.id,
                refreshReturnedSession: refreshed != null,
                verifiedOrgId: verified?.organizationId ?? null,
              },
            );
            (yield* SessionCookies).set("wos-session", "", DELETE_COOKIE_OPTIONS);
            return yield* new WorkOSError();
          }

          (yield* SessionCookies).set("wos-session", refreshed, RESPONSE_COOKIE_OPTIONS);
          return { id: org.id, name: org.name, slug: mirrored.slug };
        }),
      )
      .handle("deleteOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          const users = yield* UserStoreService;
          const autumn = yield* AutumnService;

          // Target the caller's currently-selected org (honors the org-selector
          // header, same as the other org-scoped auth handlers). NoOrganization
          // when the session has no org to act on. An org already MARKED
          // deleted still resolves here — and only here — so an admin whose
          // earlier attempt failed after the mark can send it again and finish.
          const session = yield* selectedOrganization({ deleted: "allow" });
          const organizationId = session.organizationId;

          // Admin-only. `requireSelectedOrganization` already read the caller's
          // mirrored membership, required it ACTIVE (a pending admin invite is
          // not an admin) and reported its role, so the gate is that one
          // value: a member removed or demoted moments ago is denied once the
          // write-through or the Events reconciler has landed the change.
          if (session.memberRole !== "admin") {
            return yield* new OrganizationDeletionForbidden();
          }

          // The typed confirmation must match the org's current name — the same
          // label the settings page shows. Trimmed on both sides.
          const org = yield* users.use("getOrganization", (s) => s.getOrganization(organizationId));
          if (!org || payload.confirmName.trim() !== org.name.trim()) {
            return yield* new OrganizationDeletionForbidden();
          }

          // Four steps, each idempotent, so a request that failed part-way
          // can be sent again and finish the job. The local purge is the LAST
          // step that can fail: it removes the org's membership rows — the
          // admin's own among them, the row that admits the retry above — so
          // nothing that can fail may run after it, or the retry it needs
          // would be refused at the door. And the WorkOS delete comes AFTER
          // billing: it is the one step that makes the org unrecoverable
          // outside this database, so nothing that can fail runs between it
          // and the purge except the purge itself — a billing failure leaves
          // the WorkOS org intact, the memberships still live there, and the
          // retry admitted by WorkOS and mirror alike.
          //
          // 1. Mark the org deleted LOCALLY. Membership is authorized from the
          //    local mirror (`authorizeOrganization`), not from WorkOS, so
          //    this — not the WorkOS delete — is what revokes every member's
          //    access, and it happens before anything that can fail leaves
          //    the org half-deleted. From here on every session is refused
          //    at once, whether or not the steps below land.
          yield* markOrganizationDeleted(organizationId);

          // 2. Cancel billing. A 404 — "no such customer" — is a retry after
          //    this step landed (or an org that was never provisioned):
          //    nothing to cancel, and not a failure. Matched on the status,
          //    not Autumn's `customer_not_found` code, because the delete
          //    endpoint answers an unknown customer with a bare 404 (and the
          //    Autumn emulator serves no delete route at all). Any other
          //    Autumn failure surfaces as an incomplete deletion: the WorkOS
          //    delete and the purge below must not run until billing is
          //    cancelled, because after them the admin can no longer send
          //    the request again.
          yield* autumn
            .use((client) => client.customers.delete({ customerId: organizationId }))
            .pipe(
              Effect.catchIf(
                (failure) =>
                  Predicate.isTagged(failure, "AutumnCustomerNotFoundError") ||
                  autumnStatusOf(failure) === 404,
                () =>
                  Effect.logInfo(
                    "deleteOrganization: Autumn has no customer for the org; nothing to cancel",
                    { organizationId },
                  ),
              ),
              Effect.tapError((error) =>
                Effect.logError(
                  "deleteOrganization: org marked deleted but the Autumn customer could not be deleted; retry the deletion",
                  { organizationId, error },
                ),
              ),
              Effect.mapError(() => new OrganizationDeletionIncomplete({ step: "billing" })),
            );

          // 3. Delete the WorkOS org (cascades its memberships, invitations,
          //    and domains there). "Already deleted" (404) is a retry after
          //    the purge failed, not a failure: fall through.
          yield* workos
            .deleteOrganization(organizationId)
            .pipe(
              Effect.catchTag("WorkOSError", (error) =>
                error.status === 404
                  ? Effect.logInfo(
                      "deleteOrganization: WorkOS org already deleted; finishing the deletion",
                      { organizationId },
                    )
                  : Effect.fail(error),
              ),
            );

          // 4. Purge all local tenant data, secrets, and the org's memberships
          //    in one transaction, keeping the org row as a tombstone marked
          //    deleted (step 1's mark stands; a login that fetched its
          //    membership list before the deletion cannot re-mint the org
          //    afterwards). If this fails, the org is already unreachable
          //    (step 1) but its secrets/tenant rows linger — alert loudly,
          //    surface the failure, and the admin retries: the transaction
          //    rolled back, so their membership row still admits them (read
          //    from the mirror even while it is not ready — WorkOS no longer
          //    lists the org's members); step 1 keeps its mark, and steps 2
          //    and 3 tolerate the gone customer and org, so the retry reaches
          //    this purge again.
          const deletedAt = new Date(yield* Clock.currentTimeMillis);
          yield* users
            .use("deleteOrganizationCascade", (s) =>
              s.deleteOrganizationCascade(organizationId, deletedAt),
            )
            .pipe(
              Effect.tapError((error) =>
                Effect.logError(
                  "deleteOrganization: org marked deleted, removed from WorkOS and Autumn, but local purge failed, tenant data and secrets orphaned; retry the deletion",
                  { organizationId, error },
                ),
              ),
            );

          // The caller's session is pinned to the now-deleted org — clear it so
          // the browser bounces to login and rehydrates to another membership
          // (or the create-org screen when they have none left).
          (yield* SessionCookies).set("wos-session", "", DELETE_COOKIE_OPTIONS);

          return { success: true };
        }),
      )
      .handle("pendingInvitations", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          const session = yield* SessionContext;

          const invitations = yield* workos.listInvitationsByEmail(session.email);
          const pending = invitations.data.filter(
            (i) => i.state === "pending" && i.organizationId !== null,
          );

          // Resolve org names + inviter identities in parallel. Treat
          // individual failures as "skip the field" rather than failing the
          // whole list — a stale invitation pointing at a deleted org
          // shouldn't block the user from seeing the others, and a missing
          // inviter is normal (admin-/API-created invitations have no
          // inviter user).
          const enriched = yield* Effect.all(
            pending.map((inv) =>
              Effect.gen(function* () {
                const org = yield* workos
                  .getOrganization(inv.organizationId!)
                  .pipe(Effect.orElseSucceed(() => null));
                if (!org) return null;
                const inviter = inv.inviterUserId
                  ? yield* workos.getUser(inv.inviterUserId).pipe(
                      Effect.map((u) => ({
                        email: u.email,
                        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
                      })),
                      Effect.orElseSucceed(() => null),
                    )
                  : null;
                return {
                  id: inv.id,
                  organizationId: org.id,
                  organizationName: org.name,
                  createdAt: inv.createdAt,
                  inviter,
                };
              }),
            ),
            { concurrency: "unbounded" },
          );

          return {
            invitations: enriched.filter(Predicate.isNotNull),
          };
        }),
      )
      .handle("acceptInvitation", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          const users = yield* UserStoreService;
          const session = yield* SessionContext;

          const invitation = yield* workos.acceptInvitation(payload.invitationId);

          // Defensive: invitations created without an org shouldn't reach
          // this UI, but the SDK type allows null so guard anyway.
          if (!invitation.organizationId) {
            yield* Effect.logWarning("acceptInvitation: invitation has no organizationId", {
              invitationId: payload.invitationId,
            });
            return yield* new WorkOSError();
          }

          // Mirror the org locally so domain tables can FK against it; the
          // upsert mints the slug at insert — no separate heal step.
          const org = yield* workos.getOrganization(invitation.organizationId);
          const mirrored = yield* users.use("upsertOrganization", (s) =>
            s.upsertOrganization({
              id: org.id,
              name: org.name,
              updatedAt: new Date(org.updatedAt),
            }),
          );

          // Write-through: acceptance returns the invitation, not the
          // membership it activated, so this is the one feeder that reads the
          // membership back (a rare path; one extra call). WorkOS activates it
          // as part of acceptance, so its absence is worth a warning — the
          // Events reconciler will still land it.
          const membership = yield* workos.getUserOrgMembership(org.id, session.accountId);
          if (membership) {
            yield* mirrorMembership(membership);
          } else {
            yield* Effect.logWarning(
              "acceptInvitation: accepted invitation has no membership yet",
              {
                userId: session.accountId,
                organizationId: org.id,
              },
            );
          }

          // The membership is active in WorkOS from this point even if
          // attaching the session below fails, so reconcile the org's billed
          // seat count now.
          yield* forkReportMemberSeats(org.id);

          // Attach the just-accepted org to the current session. Same shape
          // as createOrganization: refresh + verify; if we can't pin the
          // session in-place, clear the cookie and let the user bounce
          // through login again. The acceptance has already succeeded
          // server-side, so the next login will pick up the membership.
          const refreshed = yield* workos.refreshSession(session.sealedSession, org.id);
          const verified = refreshed ? yield* workos.authenticateSealedSession(refreshed) : null;

          if (!refreshed || !verified || verified.organizationId !== org.id) {
            yield* Effect.logWarning("acceptInvitation: unable to attach org to current session", {
              userId: session.accountId,
              organizationId: org.id,
              refreshReturnedSession: refreshed != null,
              verifiedOrgId: verified?.organizationId ?? null,
            });
            (yield* SessionCookies).set("wos-session", "", DELETE_COOKIE_OPTIONS);
            return yield* new WorkOSError();
          }

          (yield* SessionCookies).set("wos-session", refreshed, RESPONSE_COOKIE_OPTIONS);
          return { id: org.id, name: org.name, slug: mirrored.slug };
        }),
      )
      .handle("getMcpPaused", ({ params }) =>
        Effect.gen(function* () {
          const owner = yield* requireSelectedOrganization;
          const stub = getMcpSessionStub(params.mcpSessionId);
          const result = yield* Effect.promise(() =>
            stub.getPausedExecutionForApproval(params.executionId, {
              accountId: owner.accountId,
              organizationId: owner.organizationId,
            }),
          );

          if (result.status !== "ok") {
            return yield* failMcpApprovalResult(result, params);
          }

          return {
            text: result.text,
            structured: result.structured,
          };
        }),
      )
      .handle("resumeMcpExecution", ({ params, payload }) =>
        Effect.gen(function* () {
          const owner = yield* requireSelectedOrganization;
          const stub = getMcpSessionStub(params.mcpSessionId);
          const result = yield* Effect.promise(() =>
            stub.resumeExecutionForApproval(
              params.executionId,
              {
                accountId: owner.accountId,
                organizationId: owner.organizationId,
                orgRole: owner.memberRole,
              },
              {
                action: payload.action,
                content: payload.content as Record<string, unknown> | undefined,
                ...(payload.action === "accept" && payload.persist !== undefined
                  ? { meta: { persist: payload.persist } }
                  : {}),
              },
            ),
          );

          if (result.status !== "ok") {
            return yield* failMcpApprovalResult(result, params);
          }

          if (result.executionStatus === "paused") {
            return {
              status: "paused" as const,
              text: result.text,
              structured: result.structured,
            };
          }

          return {
            status: "completed" as const,
            text: result.text,
            structured: result.structured,
            isError: result.isError ?? false,
          };
        }),
      ),
);
