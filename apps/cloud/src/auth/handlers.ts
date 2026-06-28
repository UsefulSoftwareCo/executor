import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Duration, Effect, Predicate } from "effect";
import { isValidOrgSlug } from "@executor-js/api";

import {
  AUTH_PATHS,
  CloudAuthApi,
  CloudAuthPublicApi,
  McpExecutionNotFoundError,
  McpSessionForbiddenError,
} from "./api";
import { NoOrganization } from "@executor-js/api/server";
// Pure constants/codec module (no React) — safe in the backend graph.
import { AUTH_HINT_COOKIE } from "@executor-js/react/multiplayer/auth-hint";
import { SessionContext, SessionCookies } from "./middleware";
import { encodeLoginState, decodeLoginState } from "./login-state";
import { safeReturnTo } from "./return-to";
import { UserStoreService } from "./context";
import { env } from "cloudflare:workers";
import { WorkOSError } from "./errors";
import { WorkOSClient } from "./workos";
import { AutumnService } from "../extensions/billing/service";
import {
  hasPaidOrganizationSubscription,
  isOverFreeOrganizationLimit,
  shouldApplyFreeOrganizationLimit,
} from "../extensions/billing/plans";
import {
  ORG_SELECTOR_HEADER,
  authorizeOrganization,
  authorizeOrganizationSelector,
  resolveOrganization,
} from "./organization";
import type {
  McpSessionApprovalResult,
  McpSessionResumeApprovalResult,
} from "../mcp/session-durable-object";

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

const requireSelectedOrganization = Effect.gen(function* () {
  const session = yield* SessionContext;
  const headers = yield* requestHeaders;
  const selector = headers[ORG_SELECTOR_HEADER] ?? session.organizationId;
  if (!selector) {
    return yield* new NoOrganization();
  }

  const org = yield* authorizeOrganizationSelector(session.accountId, selector).pipe(
    Effect.catch(() => Effect.fail(new NoOrganization())),
  );
  if (!org) {
    return yield* new NoOrganization();
  }

  return {
    ...session,
    organizationId: org.id,
  };
});

const getMcpSessionStub = (mcpSessionId: string) =>
  Effect.try({
    try: () => {
      const ns = env.MCP_SESSION;
      return ns.get(ns.idFromString(mcpSessionId));
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => null));

const requireMcpSessionStub = (mcpSessionId: string, executionId: string) =>
  Effect.gen(function* () {
    const stub = yield* getMcpSessionStub(mcpSessionId);
    if (!stub) {
      return yield* new McpExecutionNotFoundError({ executionId });
    }
    return stub;
  });

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
// Single non-protected API surface — public (login/callback) + session
// (me/logout/organizations/switch-organization). The session group has SessionAuth on it.
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
          const cookieState = request.cookies[STATE_COOKIE] ?? null;
          // CSRF check is only enforced when the redirect carries a state
          // value — some WorkOS-initiated redirects don't include one.
          // When state is present, it MUST match the cookie we set on
          // /login.
          if (query.state !== undefined) {
            if (!cookieState || !timingSafeEqual(cookieState, query.state)) {
              return deleteResponseCookie(
                HttpServerResponse.text("Invalid login state", { status: 400 }),
                STATE_COOKIE,
              );
            }
          }

          const result = yield* workos.authenticateWithCode(query.code);

          // Mirror the account locally
          yield* users.use((s) => s.ensureAccount(result.user.id));

          let sealedSession = result.sealedSession;

          // Resume where the SSR gate interrupted them. The state passed the
          // CSRF check above whenever it's present, but it's still a
          // round-tripped value, so the returnTo inside it is re-validated like
          // any other untrusted path.
          const returnTo = safeReturnTo(decodeLoginState(query.state)?.returnTo) ?? "/";
          const requestedOrgSelector = requestedOrgSelectorFromReturnTo(returnTo);
          const requestedOrg = requestedOrgSelector
            ? yield* authorizeOrganizationSelector(result.user.id, requestedOrgSelector).pipe(
                Effect.orElseSucceed(() => null),
              )
            : null;

          // Prefer the org in the URL that sent the user to login. If the URL
          // is bare, or not an org route, fall back to WorkOS's org and then to
          // the first active membership for org-less sessions. Pending
          // memberships are skipped because refreshing into one 400s and would
          // bypass invite consent.
          let targetOrganizationId = requestedOrg?.id ?? result.organizationId ?? null;
          if (!targetOrganizationId && !requestedOrgSelector) {
            const memberships = yield* workos.listUserMemberships(result.user.id);
            const existingActive = memberships.data.find((m) => m.status === "active");
            targetOrganizationId = existingActive?.organizationId ?? null;
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
            return HttpServerResponse.text("Failed to create session", { status: 500 });
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
      .handleRaw("logout", () =>
        Effect.succeed(
          // The auth-hint travels with the session: leaving it behind would
          // make the next page load optimistically paint the app shell for a
          // signed-out browser.
          deleteResponseCookie(
            deleteResponseCookie(HttpServerResponse.redirect("/", { status: 302 }), "wos-session"),
            AUTH_HINT_COOKIE,
          ),
        ),
      )
      .handle("organizations", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSClient;
          const session = yield* SessionContext;

          const memberships = yield* workos.listUserMemberships(session.accountId);
          // Resolve through the mirror (not WorkOS directly) so each org's
          // URL slug is minted/read — the switcher navigates to `/<slug>`.
          const organizations = yield* Effect.all(
            memberships.data.map((m) =>
              resolveOrganization(m.organizationId).pipe(
                Effect.map((org) => ({ id: org.id, name: org.name, slug: org.slug })),
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
          const memberships = yield* workos.listUserMemberships(session.accountId);
          const activeMemberships = memberships.data.filter(
            (membership) => membership.status === "active",
          );

          if (isOverFreeOrganizationLimit(activeMemberships)) {
            const paidOrganizationIds = yield* Effect.all(
              activeMemberships.map((membership) =>
                autumn
                  .use((client) =>
                    client.customers.getOrCreate({ customerId: membership.organizationId }),
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
              Effect.catchTag("AutumnError", () => Effect.fail(new WorkOSError())),
              Effect.map((ids) => new Set(ids.filter(Predicate.isNotNull))),
            );

            if (shouldApplyFreeOrganizationLimit(activeMemberships, paidOrganizationIds)) {
              return yield* new WorkOSError();
            }
          }

          const org = yield* workos.createOrganization(name);
          yield* workos.createMembership(org.id, session.accountId, "admin");
          // `upsertOrganization` mints the slug at insert — no separate heal step.
          const mirrored = yield* users.use((s) =>
            s.upsertOrganization({ id: org.id, name: org.name }),
          );

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
          const mirrored = yield* users.use((s) =>
            s.upsertOrganization({ id: org.id, name: org.name }),
          );

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
          const stub = yield* requireMcpSessionStub(params.mcpSessionId, params.executionId);
          const result = yield* Effect.promise(
            () =>
              stub.getPausedExecutionForApproval(params.executionId, {
                accountId: owner.accountId,
                organizationId: owner.organizationId,
              }) as Promise<McpSessionApprovalResult>,
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
          const stub = yield* requireMcpSessionStub(params.mcpSessionId, params.executionId);
          const result = yield* Effect.promise(
            () =>
              stub.resumeExecutionForApproval(
                params.executionId,
                {
                  accountId: owner.accountId,
                  organizationId: owner.organizationId,
                },
                {
                  action: payload.action,
                  content: payload.content as Record<string, unknown> | undefined,
                },
              ) as Promise<McpSessionResumeApprovalResult>,
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
