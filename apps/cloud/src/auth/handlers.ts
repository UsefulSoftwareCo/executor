import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { Duration, Effect } from "effect";
import { deleteCookie } from "@tanstack/react-start/server";

import { AUTH_PATHS, CloudAuthApi, CloudAuthPublicApi } from "./api";
import { SessionContext } from "./middleware";
import { UserStoreService } from "./context";
import { env } from "cloudflare:workers";
import { WorkOSError } from "./errors";
import { WorkOSAuth } from "./workos";

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

const randomState = (): string => {
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
      .handleRaw("login", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          // Use the explicit public site URL — in dev, the request's Host
          // header points at the internal proxy target, not the public URL
          // WorkOS needs to redirect back to.
          const origin = env.VITE_PUBLIC_SITE_URL ?? "";
          const state = randomState();
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
          const workos = yield* WorkOSAuth;
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

          // If the auth response didn't surface an org but the user is already
          // an *active* member of one, rehydrate the session with it. Pending
          // memberships (which represent unaccepted invitations on WorkOS's
          // side) are skipped — refreshing into one 400s, and silently
          // attaching an unaccepted org would also bypass invite consent.
          // If they have no active memberships, leave the session org-less —
          // AuthGate's onboarding flow surfaces pending invites and the
          // create-org form. We never auto-create organizations on login.
          if (!result.organizationId && sealedSession) {
            const memberships = yield* workos.listUserMemberships(result.user.id);
            const existingActive = memberships.data.find((m) => m.status === "active");
            if (existingActive) {
              // Best-effort refresh — if WorkOS rejects (e.g. the membership
              // was just revoked), fall through to an org-less session rather
              // than 500ing the entire callback.
              const refreshed = yield* workos
                .refreshSession(sealedSession, existingActive.organizationId)
                .pipe(Effect.orElseSucceed(() => null));
              if (refreshed) sealedSession = refreshed;
            }
          }

          if (!sealedSession) {
            return HttpServerResponse.text("Failed to create session", { status: 500 });
          }

          return deleteResponseCookie(
            setResponseCookie(
              HttpServerResponse.redirect("/", { status: 302 }),
              "wos-session",
              sealedSession,
              RESPONSE_COOKIE_OPTIONS,
            ),
            STATE_COOKIE,
          );
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
          const users = yield* UserStoreService;
          const workos = yield* WorkOSAuth;

          const memberships = yield* workos.listUserMemberships(session.accountId);
          // Mirror each org locally so the local handle exists; ignore mirror
          // failures (the directory layer already has the canonical name +
          // membership — a transient db error here shouldn't blank the user's
          // org list).
          const orgs = yield* Effect.all(
            memberships.data.map((m) =>
              workos.getOrganization(m.organizationId).pipe(
                Effect.flatMap((org) =>
                  users
                    .use((s) => s.upsertOrganization({ id: org.id, name: org.name }))
                    .pipe(
                      Effect.map((mirror) => ({
                        id: mirror.id,
                        handle: mirror.handle,
                        name: org.name,
                      })),
                    ),
                ),
                Effect.orElseSucceed(() => null),
              ),
            ),
            { concurrency: "unbounded" },
          );

          const organizations = orgs
            .filter(<T>(v: T | null): v is T => v !== null)
            .sort((a, b) => a.name.localeCompare(b.name));

          return {
            user: {
              id: session.accountId,
              email: session.email,
              name: session.name,
              avatarUrl: session.avatarUrl,
            },
            organizations,
          };
        }),
      )
      .handleRaw("logout", () => {
        deleteCookie("wos-session", { path: "/" });
        return Effect.succeed(HttpServerResponse.redirect("/", { status: 302 }));
      })
      .handle("organizations", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;
          const session = yield* SessionContext;

          const memberships = yield* workos.listUserMemberships(session.accountId);
          const orgs = yield* Effect.all(
            memberships.data.map((m) =>
              workos.getOrganization(m.organizationId).pipe(
                Effect.flatMap((org) =>
                  users
                    .use((s) => s.upsertOrganization({ id: org.id, name: org.name }))
                    .pipe(
                      Effect.map((mirror) => ({
                        id: mirror.id,
                        handle: mirror.handle,
                        name: org.name,
                      })),
                    ),
                ),
                Effect.orElseSucceed(() => null),
              ),
            ),
            { concurrency: "unbounded" },
          );

          const organizations = orgs
            .filter(<T>(v: T | null): v is T => v !== null)
            .sort((a, b) => a.name.localeCompare(b.name));

          return { organizations };
        }),
      )
      .handle("createOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;
          const session = yield* SessionContext;

          const name = payload.name.trim();
          const org = yield* workos.createOrganization(name);
          yield* workos.createMembership(org.id, session.accountId, "admin");
          const mirrored = yield* users.use((s) =>
            s.upsertOrganization({ id: org.id, name: org.name }),
          );
          // No session refresh — the URL is the source of truth for active
          // org now, so the client just navigates to /:handle/... after
          // create. The WorkOS session's `organizationId` only proves login
          // identity; it doesn't gate per-org access (that goes through the
          // membership check on the URL-resolved org).
          return { id: org.id, handle: mirrored.handle, name: org.name };
        }),
      )
      .handle("pendingInvitations", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
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
            invitations: enriched.filter((i): i is NonNullable<typeof i> => i !== null),
          };
        }),
      )
      .handle("acceptInvitation", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;

          const invitation = yield* workos.acceptInvitation(payload.invitationId);

          // Defensive: invitations created without an org shouldn't reach
          // this UI, but the SDK type allows null so guard anyway.
          if (!invitation.organizationId) {
            yield* Effect.logWarning("acceptInvitation: invitation has no organizationId", {
              invitationId: payload.invitationId,
            });
            return yield* new WorkOSError();
          }

          // Mirror the org locally so domain tables can FK against it and
          // the URL handle exists by the time the client navigates.
          const org = yield* workos.getOrganization(invitation.organizationId);
          yield* users.use((s) => s.upsertOrganization({ id: org.id, name: org.name }));

          // No session refresh — the URL is the source of truth for active
          // org. The client refreshes the auth atom and navigates to the
          // new org's `/$handle` after this resolves.
          return { id: org.id, name: org.name };
        }),
      ),
);
