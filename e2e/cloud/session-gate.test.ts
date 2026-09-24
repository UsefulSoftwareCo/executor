// Cloud-specific: the SSR auth gate's session handling BEYOND the basic
// signed-out redirect (unauthenticated-skeleton.test.ts owns that): an
// invalid cookie is actively cleared, /cloud (the marketing CTA path) routes
// into the app, and — the nastiest path — a session whose access token no
// longer verifies is refreshed in-flight, with the rotated sealed session
// reaching the browser. WorkOS refresh tokens are single-use, so losing that
// Set-Cookie silently logs the user out on next expiry; these scenarios pin
// it against the real WorkOS emulator (real rotation, real revocation).
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import * as Iron from "iron-webcrypto";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import { E2E_COOKIE_PASSWORD } from "../targets/cloud";

/** A signed-out-style document request (what the gate keys on). */
const documentRequest = (url: URL, cookie?: string) =>
  Effect.promise(() =>
    fetch(url, {
      redirect: "manual",
      headers: { accept: "text/html", ...(cookie ? { cookie } : {}) },
    }),
  );

const setCookieFor = (response: Response, name: string): string => {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header;
  }
  return "";
};

scenario(
  "Session gate · an invalid session cookie is cleared on the way to /login",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    // A cookie that was never a sealed session. On executor.sh its mere
    // presence routes / past the marketing page, so the gate must not just
    // redirect — it must take the cookie (and the auth hint beside it) away.
    const response = yield* documentRequest(
      new URL("/", target.baseUrl),
      "wos-session=not-a-real-session; executor-auth-hint=stale",
    );
    expect(response.status, "an unverifiable session is signed out").toBe(302);
    expect(response.headers.get("location"), "…to the login page").toBe("/login");

    const clearedSession = setCookieFor(response, "wos-session");
    expect(clearedSession, "the dead session cookie is dropped").toContain("Max-Age=0");
    const clearedHint = setCookieFor(response, "executor-auth-hint");
    expect(clearedHint, "the auth hint goes with it").toContain("Max-Age=0");
  }),
);

scenario(
  "Session gate · /cloud (the marketing CTA path) routes into the app",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    // Marketing CTAs link to /cloud, which is not a route — it means "open
    // the app". Signed out, that lands on login (no returnTo: the deep link
    // IS the root)…
    const signedOut = yield* documentRequest(new URL("/cloud", target.baseUrl));
    expect(signedOut.status, "signed-out /cloud is gated like any page").toBe(302);
    expect(signedOut.headers.get("location"), "…straight to login").toBe("/login");

    // …and signed in, it opens the app at the root instead of 404ing.
    const identity = yield* target.newIdentity();
    const signedIn = yield* documentRequest(
      new URL("/cloud", target.baseUrl),
      identity.headers!.cookie!,
    );
    expect(signedIn.status, "signed-in /cloud is a redirect, not a 404").toBe(302);
    expect(signedIn.headers.get("location"), "…into the app").toBe("/");
  }),
);

scenario(
  "Session gate · an org-less session is sent to onboarding before the app shell exists",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    // A verified user with no organization belongs in onboarding — the gate
    // decides that at the edge, so the app shell (whose every query needs an
    // org) is never even served.
    const orgless = yield* target.newIdentity({ org: false });
    const gated = yield* documentRequest(
      new URL("/tools", target.baseUrl),
      orgless.headers!.cookie!,
    );
    expect(gated.status, "the app page is not served org-less").toBe(302);
    expect(gated.headers.get("location"), "…onboarding owns this session").toBe("/create-org");

    // The onboarding page itself is served (no redirect loop).
    const onboarding = yield* documentRequest(
      new URL("/create-org", target.baseUrl),
      orgless.headers!.cookie!,
    );
    expect(onboarding.status, "/create-org renders for the org-less session").toBe(200);
  }),
);

// The sealed wos-session is iron-sealed JSON { accessToken, refreshToken, … }.
// Corrupting the access token's signature makes the gate's verify fail the
// same way an EXPIRED token does (invalid JWT → refresh path) — without
// waiting out a real expiry. Same sealing library + password map the WorkOS
// SDK uses, so the gate can't tell this seal from one the SDK minted.
const withTamperedAccessToken = async (sessionCookie: string): Promise<string> => {
  const sealed = sessionCookie.slice("wos-session=".length).replace(/~\d$/, "");
  const session = (await Iron.unseal(sealed, { "1": E2E_COOKIE_PASSWORD }, Iron.defaults)) as {
    accessToken: string;
  };
  const [header, payload, signature] = session.accessToken.split(".");
  const tampered = {
    ...session,
    accessToken: `${header}.${payload}.${[...(signature ?? "")].reverse().join("")}`,
  };
  const resealed = await Iron.seal(
    tampered,
    { id: "1", secret: E2E_COOKIE_PASSWORD },
    Iron.defaults,
  );
  return `wos-session=${resealed}~2`;
};

scenario(
  "Session gate · a stale access token is refreshed in-flight and the rotated session reaches the browser",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    const identity = yield* target.newIdentity();
    const staleCookie = yield* Effect.promise(() =>
      withTamperedAccessToken(identity.headers!.cookie!),
    );

    // 1. The page is served (no login detour) — the gate refreshed the
    //    session against WorkOS mid-request — and the ROTATED sealed session
    //    is set on the response. Refresh tokens are single-use: dropping
    //    this Set-Cookie would log the user out at the next expiry.
    const refreshed = yield* documentRequest(new URL("/", target.baseUrl), staleCookie);
    expect(refreshed.status, "a refreshable session still gets the page").toBe(200);
    const rotated = setCookieFor(refreshed, "wos-session");
    expect(rotated, "the rotated sealed session is persisted").toContain("Max-Age=");
    expect(rotated, "…as a fresh value, not the stale one").not.toContain(
      staleCookie.slice("wos-session=".length, 80),
    );

    // 2. The rotation was real: the OLD session's refresh token is revoked
    //    server-side, so replaying the stale cookie now signs out.
    const replayed = yield* documentRequest(new URL("/", target.baseUrl), staleCookie);
    expect(replayed.status, "the spent session is refused").toBe(302);
    expect(replayed.headers.get("location"), "…and signed out to login").toBe("/login");
    expect(
      setCookieFor(replayed, "wos-session"),
      "the spent cookie is cleared, not left to retry forever",
    ).toContain("Max-Age=0");

    // 3. And the rotated session the browser was handed actually works.
    const rotatedCookie = rotated.split(";")[0]!;
    const next = yield* documentRequest(new URL("/tools", target.baseUrl), rotatedCookie);
    expect(next.status, "the rotated session opens the app").toBe(200);
  }),
);
