// Cloud session + membership helpers shared by the scenarios that need MORE
// than one identity in an org.
//
// Every one of these is a thin wrapper over a REAL product endpoint — there is
// no back door here. They were copy-pasted verbatim into four cloud scenarios
// before living here, and the copies drifted in the two ways that matter, both
// now folded in:
//
//   - only one carried `forBrowser`, the fix for the fact that `joinOrg`
//     refreshes `headers.cookie` (the sealed session is re-issued on the new
//     org) but leaves `cookies` on the PRE-join value — and the browser context
//     is seeded from `cookies`. A scenario on a stale copy browses as the
//     person's old org while its API calls use the new one.
//   - only one forwarded the ORG SELECTOR header. Org-scoped endpoints fail
//     closed without it (`AccountNoOrganization`), so a cookie-only copy cannot
//     even build the fixture: `/api/account/members/invite` 403s.
//
// `cloud/*.test.ts` is a vitest `include` of `*.test.ts` only, so this module
// is never collected as a suite.
import { Effect } from "effect";

import type { Identity, Target as TargetShape } from "../../src/target";

/**
 * The per-request org selector. `/api/auth/switch-organization` was removed
 * (#1000): the URL prefix or this header is the scope authority now, and the
 * session's own org is only a default.
 *
 * This is the RIGHT way to read one account's data in a specific org: a session
 * cookie captured before the account joined another org is stale the moment the
 * later `accept-invitation` re-seals it, so holding onto the old cookie reads as
 * an unauthenticated caller. Take the CURRENT identity and point it at the org
 * you mean.
 *
 * Mirrors `ORG_SELECTOR_HEADER` in `apps/cloud/src/auth/organization.ts`
 * (`EXECUTOR_ORG_SELECTOR_HEADER` in the SDK's shared exports); duplicated as a
 * literal so the e2e suite stays a black-box client of the deployed product.
 */
const ORG_SELECTOR_HEADER = "x-executor-organization";

/** The session cookie header this identity authenticates API calls with. */
export const cookieOf = (identity: Identity): string => identity.headers?.["cookie"] ?? "";

/**
 * The identity re-bound so the BROWSER carries the same session the API calls
 * do. `joinOrg` / `createOrg` refresh `headers.cookie` (the org is baked into
 * the sealed session) but leave `cookies` on the pre-change value, and the
 * browser context is seeded from `cookies`.
 */
export const forBrowser = (identity: Identity): Identity => {
  const cookie = cookieOf(identity);
  const separator = cookie.indexOf("=");
  if (separator < 0) throw new Error("identity carries no session cookie");
  return {
    ...identity,
    cookies: [{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }],
  };
};

/** POST as `identity`, failing loudly on a non-2xx (a silent skip here would
 *  leave the scenario asserting against a half-built fixture).
 *
 *  Sends the identity's OWN headers, not just its cookie: org-scoped endpoints
 *  (`/api/account/members/invite` among them) fail closed with
 *  `AccountNoOrganization` when the org selector header is absent, because the
 *  session's own org is only a default and is never fallen back to. */
export const postJson = (
  target: TargetShape,
  path: string,
  identity: Identity,
  body: unknown,
): Effect.Effect<Response> =>
  Effect.promise(async () => {
    const response = await fetch(new URL(path, target.baseUrl), {
      method: "POST",
      headers: {
        ...(identity.headers ?? {}),
        "content-type": "application/json",
        origin: new URL(target.baseUrl).origin,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
    }
    return response;
  });

/** The identity re-bound to the refreshed session cookie a response set, and
 *  scoped to `orgSelector` — carrying the cookie alone would leave every
 *  org-scoped read the identity goes on to make failing closed. */
export const withRefreshedSession = (
  identity: Identity,
  response: Response,
  orgSelector: string,
): Identity => {
  const refreshed = (response.headers.getSetCookie?.() ?? [])
    .find((header) => header.startsWith("wos-session="))
    ?.split(";")[0];
  if (!refreshed) throw new Error("response did not refresh the session cookie");
  return { ...identity, headers: { cookie: refreshed, [ORG_SELECTOR_HEADER]: orgSelector } };
};

/** The org selector this identity's requests carry — the same header the web
 *  client derives from the console URL's slug. */
export const orgSelectorOf = (identity: Identity): string => {
  const selector = identity.headers?.[ORG_SELECTOR_HEADER];
  if (!selector) throw new Error(`identity ${identity.label} carries no org selector header`);
  return selector;
};

/**
 * Invite `member` into `admin`'s org and accept — the real invite flow. The
 * invite carries no roleSlug, so the joiner lands as a plain MEMBER (the actor
 * an access-denial assertion needs); pass `roleSlug` for anything else.
 *
 * The returned identity is bound to the newly-joined org — the re-sealed
 * session from accept-invitation, scoped by the selector to the org they were
 * invited INTO (`admin`'s). Calling this twice for one person is how a scenario
 * builds a multi-org member: the WorkOS membership in the earlier org persists,
 * and both the session and the selector point at the later one.
 */
export const joinOrg = (
  target: TargetShape,
  admin: Identity,
  member: Identity,
  options: { readonly roleSlug?: string } = {},
): Effect.Effect<Identity> =>
  Effect.gen(function* () {
    const inviteResponse = yield* postJson(target, "/api/account/members/invite", admin, {
      email: member.credentials?.email,
      ...(options.roleSlug === undefined ? {} : { roleSlug: options.roleSlug }),
    });
    const invitation = (yield* Effect.promise(() => inviteResponse.json())) as { id: string };
    const acceptResponse = yield* postJson(target, "/api/auth/accept-invitation", member, {
      invitationId: invitation.id,
    });
    return withRefreshedSession(member, acceptResponse, orgSelectorOf(admin));
  });

/** Create another org for this account; returns the identity bound to it. */
export const createOrg = (
  target: TargetShape,
  identity: Identity,
  name: string,
): Effect.Effect<Identity> =>
  Effect.gen(function* () {
    const response = yield* postJson(target, "/api/auth/create-organization", identity, { name });
    const created = (yield* Effect.promise(() => response.clone().json())) as { id: string };
    return withRefreshedSession(identity, response, created.id);
  });

/** This identity, scoped to `organizationId` for the requests it makes. */
export const inOrg = (identity: Identity, organizationId: string): Identity => ({
  ...identity,
  headers: { ...identity.headers, [ORG_SELECTOR_HEADER]: organizationId },
});

/** The caller's own account id — the `externalId` the admin plane reports and
 *  the users page renders in mono. */
export const accountIdOf = (target: TargetShape, identity: Identity): Effect.Effect<string> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/account/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/account/me failed (${response.status})`);
    const body = (await response.json()) as { user: { id: string } };
    return body.user.id;
  });

/** The org this identity's session is currently bound to: id and URL slug. */
export const activeOrg = (
  target: TargetShape,
  identity: Identity,
): Effect.Effect<{ readonly id: string; readonly slug: string }> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as {
      organization: { id: string; slug: string } | null;
    };
    if (!body.organization) throw new Error("identity has no active organization");
    return { id: body.organization.id, slug: body.organization.slug };
  });

/** Every org this account is a member of, plus the one the session is on. */
export const organizationsOf = (
  target: TargetShape,
  identity: Identity,
): Effect.Effect<{
  readonly organizations: ReadonlyArray<{ readonly id: string; readonly slug: string }>;
  readonly activeOrganizationId: string | null;
}> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/organizations", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/organizations failed (${response.status})`);
    return (await response.json()) as {
      organizations: ReadonlyArray<{ id: string; slug: string }>;
      activeOrganizationId: string | null;
    };
  });
