// Organization membership over the REAL product auth endpoints — the same
// cookie-authenticated calls the web app makes, whose responses re-seal the
// session when the active org changes. Scenarios compose these to build
// genuine multi-user orgs: mint the admin with `newIdentity()` (fresh user +
// org), mint teammates with `newIdentity({ org: false })`, then `joinOrg`
// them through the real invite → accept-invitation flow.
//
// These are raw fetches (not the typed HttpApiClient) because the org
// endpoints live on the auth layer (/api/auth/*), not in an HttpApi group —
// and because the refreshed `wos-session` cookie in each response IS the
// result: identity rebinding is the whole point.
import { Effect } from "effect";

import type { Identity, Target } from "./target";

const cookieOf = (identity: Identity): string => identity.headers?.["cookie"] ?? "";

export const postJson = (target: Target, path: string, identity: Identity, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(path, target.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(target.baseUrl).origin,
        cookie: cookieOf(identity),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
    }
    return response;
  });

/** The identity re-bound to the refreshed session cookie a response set. */
export const withRefreshedSession = (identity: Identity, response: Response): Identity => {
  const refreshed = (response.headers.getSetCookie?.() ?? [])
    .find((header) => header.startsWith("wos-session="))
    ?.split(";")[0];
  if (!refreshed) throw new Error("response did not refresh the session cookie");
  const [name, value] = refreshed.split(/=(.*)/s);
  return {
    ...identity,
    headers: { cookie: refreshed },
    cookies: [{ name: name!, value: value! }],
  };
};

/** Invite `member` into `admin`'s org and accept — the real invite flow.
 *  Returns the member identity with its session re-bound to that org. */
export const joinOrg = (target: Target, admin: Identity, member: Identity) =>
  Effect.gen(function* () {
    const inviteResponse = yield* postJson(target, "/api/account/members/invite", admin, {
      email: member.credentials?.email,
    });
    const invitation = (yield* Effect.promise(() => inviteResponse.json())) as { id: string };
    const acceptResponse = yield* postJson(target, "/api/auth/accept-invitation", member, {
      invitationId: invitation.id,
    });
    return withRefreshedSession(member, acceptResponse);
  });

/** Create another org for this account; returns the identity bound to it. */
export const createAnotherOrg = (target: Target, identity: Identity, name: string) =>
  Effect.gen(function* () {
    const response = yield* postJson(target, "/api/auth/create-organization", identity, { name });
    return withRefreshedSession(identity, response);
  });

/** Switch this account's active org; returns the identity bound to it. */
export const switchOrg = (target: Target, identity: Identity, organizationId: string) =>
  Effect.gen(function* () {
    const response = yield* postJson(target, "/api/auth/switch-organization", identity, {
      organizationId,
    });
    return withRefreshedSession(identity, response);
  });

/** The org this identity's session is currently bound to. */
export const activeOrganizationId = (target: Target, identity: Identity) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as { organization: { id: string } | null };
    if (!body.organization) throw new Error("identity has no active organization");
    return body.organization.id;
  });
