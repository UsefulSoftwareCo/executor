// Cloud-only: the WorkOS login → AuthKit → callback session contract, driven
// over the wire against the real handlers (AuthKit is the emulator). The happy
// path itself is what `newIdentity()` performs on every scenario — these
// scenarios pin the EDGE guarantees around it: the CSRF state handshake, the
// callback refusing forged/incomplete redirects, the sealed-session cookie
// actually authorizing the session API, and logout dropping the cookie.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

/** First `Set-Cookie` header for `name`, as the raw header string. */
const setCookieFor = (response: Response, name: string): string => {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header;
  }
  return "";
};

scenario(
  "Auth · login redirects to hosted AuthKit carrying a short-lived CSRF state cookie",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/login", target.baseUrl), { redirect: "manual" }),
    );
    expect(response.status, "login hands the browser to AuthKit").toBe(302);

    const authorizeUrl = new URL(response.headers.get("location") ?? "");
    const state = authorizeUrl.searchParams.get("state") ?? "";
    expect(state, "the redirect carries an unguessable CSRF state").toMatch(/^[0-9a-f]{64}$/);
    expect(
      authorizeUrl.searchParams.get("redirect_uri"),
      "AuthKit is told to come back to this deployment's callback",
    ).toBe(new URL("/api/auth/callback", target.baseUrl).toString());

    const stateCookie = setCookieFor(response, "wos-login-state");
    expect(stateCookie, "the same state is pinned in a cookie for the callback").toContain(
      `wos-login-state=${state}`,
    );
    expect(stateCookie, "the login state expires quickly").toContain("Max-Age=600");
    expect(stateCookie, "the login state is not readable by page scripts").toContain("HttpOnly");
  }),
);

scenario(
  "Auth · the callback rejects forged or incomplete redirects without exchanging the code",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    const callback = (search: string, cookie?: string) =>
      Effect.promise(() =>
        fetch(new URL(`/api/auth/callback${search}`, target.baseUrl), {
          redirect: "manual",
          ...(cookie ? { headers: { cookie } } : {}),
        }),
      );

    // A state that matches no login-state cookie (no login ever started).
    const noCookie = yield* callback("?code=attacker-code&state=attacker-state");
    expect(noCookie.status, "a state with no matching login cookie is refused").toBe(400);
    expect(
      setCookieFor(noCookie, "wos-session"),
      "no session is minted from the forged redirect",
    ).toBe("");

    // A state that contradicts the login-state cookie the browser holds.
    const mismatched = yield* callback(
      "?code=attacker-code&state=attacker-state",
      "wos-login-state=0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(mismatched.status, "a state contradicting the login cookie is refused").toBe(400);
    expect(
      setCookieFor(mismatched, "wos-session"),
      "no session is minted from the mismatched redirect",
    ).toBe("");

    // A redirect that never carried the authorization code at all.
    const noCode = yield* callback("");
    expect(noCode.status, "a callback without a code is refused").toBe(400);
  }),
);

scenario(
  "Auth · a completed login's session cookie authorizes the session API",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    // newIdentity() IS the full product login (login → AuthKit → callback);
    // its headers carry the genuine sealed-session cookie the callback set.
    const identity = yield* target.newIdentity();

    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/me", target.baseUrl), { headers: identity.headers ?? {} }),
    );
    expect(response.status, "the sealed-session cookie is accepted").toBe(200);
    const me = (yield* Effect.promise(() => response.json())) as {
      user: { email: string };
      organization: { id: string } | null;
    };
    expect(me.user.email, "the session belongs to the user who logged in").toBe(identity.label);
    expect(me.organization?.id, "the session carries the active organization").toMatch(/^org_/);
  }),
);

scenario(
  "Auth · logout sends the user home and tells the browser to drop the session",
  {},
  Effect.gen(function* () {
    // Gate: the REST API plane is mounted on this target.
    yield* Api;
    const target = yield* Target;

    const identity = yield* target.newIdentity();

    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/auth/logout", target.baseUrl), {
        method: "POST",
        redirect: "manual",
        headers: identity.headers ?? {},
      }),
    );
    expect(response.status, "logout redirects back to the landing page").toBe(302);
    expect(response.headers.get("location"), "the destination is home").toBe("/");
    const cleared = setCookieFor(response, "wos-session");
    expect(cleared, "the session cookie is expired immediately").toContain("Max-Age=0");
    expect(cleared, "the cookie value is wiped").toContain("wos-session=;");
  }),
);
