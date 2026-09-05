import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, test } from "@effect/vitest";
import { createEmulator } from "@executor-js/emulate";

import { mintInviteCode } from "../testing/mint-invite";

// Real Better Auth path with an SSO provider configured — and a REAL IdP on the
// wire: an @executor-js/emulate Okta instance serving OIDC discovery,
// authorize, and token, so the round-trip tests below exercise the same
// discovery -> redirect -> consent -> callback flow a production Google/Okta
// deployment does. Emulator + registered client + env must all exist before
// the app import, so `loadConfig` sees a fully-configured instance at boot.
const BASE = "http://localhost:4788";
const CALLBACK = `${BASE}/api/auth/oauth2/callback/okta`;

const idp = await createEmulator({ service: "okta", port: 4790 });
afterAll(() => idp.close());

const registration = await fetch(`${idp.url}/oauth2/v1/clients`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "executor-selfhost-test",
    redirect_uris: [CALLBACK],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  }),
}).then((r) => r.json() as Promise<{ client_id: string; client_secret: string }>);

const createIdpUser = (email: string, firstName: string) =>
  fetch(`${idp.url}/api/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "SSWS test" },
    body: JSON.stringify({ profile: { login: email, email, firstName, lastName: "User" } }),
  });
await createIdpUser("alice@example.com", "Alice");
await createIdpUser("mallory@evil.test", "Mallory");

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-sso-"));
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";
process.env.EXECUTOR_SSO_PROVIDER_ID = "okta";
process.env.EXECUTOR_SSO_DISCOVERY_URL = `${idp.url}/.well-known/openid-configuration`;
process.env.EXECUTOR_SSO_CLIENT_ID = registration.client_id;
process.env.EXECUTOR_SSO_CLIENT_SECRET = registration.client_secret;
process.env.EXECUTOR_SSO_ALLOWED_DOMAINS = "Example.com, @second.example ,";

const { loadConfig } = await import("../config");
const { emailDomain } = await import("./sso");
const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const SSO_ENV_KEYS = [
  "EXECUTOR_SSO_PROVIDER_ID",
  "EXECUTOR_SSO_PROVIDER_NAME",
  "EXECUTOR_SSO_DISCOVERY_URL",
  "EXECUTOR_SSO_CLIENT_ID",
  "EXECUTOR_SSO_CLIENT_SECRET",
  "EXECUTOR_SSO_ALLOWED_DOMAINS",
] as const;

// Run a block with the SSO env vars swapped out, restoring them afterwards so
// the booted instance's request-time config reads stay consistent.
const withSsoEnv = <T>(overrides: Record<string, string | undefined>, run: () => T): T => {
  const saved = Object.fromEntries(SSO_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of SSO_ENV_KEYS) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: env save/restore around config reads must restore on assertion failure
  try {
    return run();
  } finally {
    for (const key of SSO_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe("sso config resolution", () => {
  it("normalizes the domain allowlist (trim, lowercase, strip @, drop empties)", () => {
    const sso = loadConfig().sso;
    expect(sso).toBeDefined();
    expect(sso!.allowedDomains).toEqual(["example.com", "second.example"]);
  });

  it("derives the display name from the provider id when not set", () => {
    expect(loadConfig().sso!.providerName).toBe("Okta");
  });

  it("is undefined when no SSO env is set", () => {
    withSsoEnv({}, () => {
      expect(loadConfig().sso).toBeUndefined();
    });
  });

  it("refuses half-configured credentials", () => {
    withSsoEnv({ EXECUTOR_SSO_CLIENT_ID: "id-only" }, () => {
      expect(() => loadConfig()).toThrow(/must be set together/);
    });
  });

  it("refuses credentials without a provider id", () => {
    withSsoEnv({ EXECUTOR_SSO_CLIENT_ID: "id", EXECUTOR_SSO_CLIENT_SECRET: "secret" }, () => {
      expect(() => loadConfig()).toThrow(/EXECUTOR_SSO_PROVIDER_ID/);
    });
  });

  it("presets Google's discovery document so only credentials + domains are needed", () => {
    withSsoEnv(
      {
        EXECUTOR_SSO_PROVIDER_ID: "google",
        EXECUTOR_SSO_CLIENT_ID: "id.apps.googleusercontent.com",
        EXECUTOR_SSO_CLIENT_SECRET: "secret",
        EXECUTOR_SSO_ALLOWED_DOMAINS: "example.com",
      },
      () => {
        const sso = loadConfig().sso;
        expect(sso!.discoveryUrl).toBe(
          "https://accounts.google.com/.well-known/openid-configuration",
        );
        expect(sso!.providerName).toBe("Google");
      },
    );
  });

  it("refuses a provider without a known or explicit discovery URL", () => {
    withSsoEnv(
      {
        EXECUTOR_SSO_PROVIDER_ID: "okta",
        EXECUTOR_SSO_CLIENT_ID: "id",
        EXECUTOR_SSO_CLIENT_SECRET: "secret",
        EXECUTOR_SSO_ALLOWED_DOMAINS: "example.com",
      },
      () => {
        expect(() => loadConfig()).toThrow(/EXECUTOR_SSO_DISCOVERY_URL/);
      },
    );
  });

  it("refuses a configured provider without a domain allowlist", () => {
    withSsoEnv(
      {
        EXECUTOR_SSO_PROVIDER_ID: "okta",
        EXECUTOR_SSO_DISCOVERY_URL: "https://idp.example/.well-known/openid-configuration",
        EXECUTOR_SSO_CLIENT_ID: "id",
        EXECUTOR_SSO_CLIENT_SECRET: "secret",
      },
      () => {
        expect(() => loadConfig()).toThrow(/EXECUTOR_SSO_ALLOWED_DOMAINS/);
      },
    );
  });
});

describe("emailDomain", () => {
  it("extracts the lowercased domain of a well-formed address", () => {
    expect(emailDomain("User@Example.COM")).toBe("example.com");
  });

  it("returns null for malformed addresses instead of a matchable domain", () => {
    expect(emailDomain("@example.com")).toBeNull();
    expect(emailDomain("user@")).toBeNull();
    expect(emailDomain("no-at-sign")).toBeNull();
  });
});

test("auth-config advertises the configured provider (id + name only)", async () => {
  const res = await handler(new Request(`${BASE}/api/auth-config`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ssoProviders: [{ id: "okta", name: "Okta" }] });
});

// --- The full OIDC round-trip against the emulated IdP -----------------------

const decodeHtml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const formFields = (form: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) fields[decodeHtml(name)] = decodeHtml(value);
  }
  return fields;
};

// Drive the whole flow as the given IdP account: sign-in redirect -> IdP
// consent page (pick the account's form) -> callback back into the app.
// Returns the callback response plus the cookies it set.
const signInThroughIdp = async (email: string) => {
  const start = await handler(
    new Request(`${BASE}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "okta", callbackURL: "/" }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  expect(url.startsWith(idp.url)).toBe(true);
  const stateCookies = start.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .join("; ");

  const consentHtml = await fetch(url).then((r) => r.text());
  const form = [...consentHtml.matchAll(/<form[\s\S]*?<\/form>/gi)]
    .map((m) => m[0])
    .find((f) => f.includes(email));
  expect(form).toBeDefined();
  const action = decodeHtml(form!.match(/\baction=["']([^"']+)["']/i)![1]!);
  const consent = await fetch(action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(formFields(form!)),
    redirect: "manual",
  });
  expect(consent.status).toBe(302);
  const callbackUrl = consent.headers.get("location")!;
  expect(callbackUrl.startsWith(CALLBACK)).toBe(true);

  const callback = await handler(new Request(callbackUrl, { headers: { cookie: stateCookies } }));
  const cookies = callback.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .join("; ");
  return { callback, cookies };
};

test("an allowlisted-domain IdP account signs in and joins the org as a member", async () => {
  const { callback, cookies } = await signInThroughIdp("alice@example.com");
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");

  const session = await handler(
    new Request(`${BASE}/api/auth/get-session`, { headers: { cookie: cookies } }),
  );
  expect(session.status).toBe(200);
  const sessionBody = (await session.json()) as { user?: { email?: string } };
  expect(sessionBody.user?.email).toBe("alice@example.com");

  const orgs = await handler(
    new Request(`${BASE}/api/auth/organization/list`, { headers: { cookie: cookies } }),
  );
  expect(orgs.status).toBe(200);
  expect(((await orgs.json()) as unknown[]).length).toBe(1);
});

test("an IdP account outside the allowlist is refused and gets no session", async () => {
  const { callback, cookies } = await signInThroughIdp("mallory@evil.test");
  // The rejection surfaces as better-auth's error redirect, not a success.
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).not.toBe("/");
  expect(callback.headers.get("location")).toContain("error");

  const session = await handler(
    new Request(`${BASE}/api/auth/get-session`, { headers: { cookie: cookies } }),
  );
  const sessionBody = (await session.json()) as { user?: unknown } | null;
  expect(sessionBody?.user ?? null).toBeNull();
});

// --- Invite-code regressions with SSO configured ------------------------------

test("invite-gated email signup still works with an SSO provider configured", async () => {
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.local",
        password: "member-password-123",
        name: "Member",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
});

test("email signup without an invite is still refused with an SSO provider configured", async () => {
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "stranger@example.com",
        password: "stranger-password-123",
        name: "Stranger",
      }),
    }),
  );
  expect(signUp.status).toBe(403);
});
