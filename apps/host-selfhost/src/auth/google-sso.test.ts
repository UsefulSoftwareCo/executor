import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// Real Better Auth path with Google sign-in configured: set the provider env
// (like the secret + bootstrap admin) before importing, so `loadConfig` sees a
// fully-configured instance when the app graph boots.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-google-"));
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";
process.env.EXECUTOR_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.EXECUTOR_GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.EXECUTOR_GOOGLE_ALLOWED_DOMAINS = "Example.com, @second.example ,";

const { loadConfig } = await import("../config");
const { emailDomain } = await import("./better-auth");
const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "http://localhost:4788";

// Run a block with the Google env vars swapped out, restoring them afterwards
// so the booted instance's request-time config reads stay consistent.
const withGoogleEnv = <T>(overrides: Record<string, string | undefined>, run: () => T): T => {
  const keys = [
    "EXECUTOR_GOOGLE_CLIENT_ID",
    "EXECUTOR_GOOGLE_CLIENT_SECRET",
    "EXECUTOR_GOOGLE_ALLOWED_DOMAINS",
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const key of keys) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: env save/restore around config reads must restore on assertion failure
  try {
    return run();
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe("googleSso config resolution", () => {
  it("normalizes the domain allowlist (trim, lowercase, strip @, drop empties)", () => {
    const sso = loadConfig().googleSso;
    expect(sso).toBeDefined();
    expect(sso!.allowedDomains).toEqual(["example.com", "second.example"]);
  });

  it("is undefined when no Google env is set", () => {
    withGoogleEnv({}, () => {
      expect(loadConfig().googleSso).toBeUndefined();
    });
  });

  it("refuses half-configured credentials", () => {
    withGoogleEnv({ EXECUTOR_GOOGLE_CLIENT_ID: "id-only" }, () => {
      expect(() => loadConfig()).toThrow(/must be set together/);
    });
  });

  it("refuses a configured provider without a domain allowlist", () => {
    withGoogleEnv(
      {
        EXECUTOR_GOOGLE_CLIENT_ID: "id",
        EXECUTOR_GOOGLE_CLIENT_SECRET: "secret",
      },
      () => {
        expect(() => loadConfig()).toThrow(/EXECUTOR_GOOGLE_ALLOWED_DOMAINS/);
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

test("auth-config advertises the configured provider (ids only)", async () => {
  const res = await handler(new Request(`${BASE}/api/auth-config`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ socialProviders: ["google"] });
});

test("social sign-in redirects to the configured Google client", async () => {
  const res = await handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url?: string };
  expect(body.url).toBeTruthy();
  const url = new URL(body.url!);
  expect(url.hostname).toBe("accounts.google.com");
  expect(url.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
  expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
});

test("invite-gated email signup still works with a social provider configured", async () => {
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

test("email signup without an invite is still refused with a social provider configured", async () => {
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
