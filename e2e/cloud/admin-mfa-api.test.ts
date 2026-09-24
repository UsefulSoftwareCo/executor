import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TOTP } from "otpauth";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { verifyAdmin, responseCookies } from "./support/admin-mfa";

const decodeKey = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, value: Schema.String }),
);

const decodeSetup = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal("enroll"), secret: Schema.String }),
);

scenario(
  "Admin MFA API · requires same-origin requests and binds verification to the session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const identity = yield* target.newIdentity({ adminMfa: false });
    const other = yield* target.newIdentity({ adminMfa: false });
    yield* Effect.promise(async () => {
      const original = identity.headers?.cookie ?? "";
      const headers = { ...identity.headers, "content-type": "application/json" };
      const unverifiedWorkspace = await fetch(new URL("/api/policies", target.baseUrl), {
        headers,
      });
      expect(unverifiedWorkspace.status).toBe(200);
      const key = await fetch(new URL("/api/account/api-keys", target.baseUrl), {
        method: "POST",
        headers: { ...headers, origin: new URL(target.baseUrl).origin },
        body: JSON.stringify({ name: "unverified-admin" }),
      });
      expect(key.status).toBe(200);
      const billing = await fetch(new URL("/api/billing/getOrCreateCustomer", target.baseUrl), {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(billing.status).toBe(200);
      const post = (action: string, cookie: string, code?: string) =>
        fetch(new URL(`/api/auth/admin-mfa/${action}`, target.baseUrl), {
          method: "POST",
          headers: { ...headers, origin: new URL(target.baseUrl).origin, cookie },
          body: JSON.stringify(code === undefined ? {} : { code }),
        });
      const noOrigin = await fetch(new URL("/api/auth/admin-mfa/start", target.baseUrl), {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(noOrigin.status).toBe(403);
      const crossOrigin = await fetch(new URL("/api/auth/admin-mfa/start", target.baseUrl), {
        method: "POST",
        headers: { ...headers, origin: "https://other.example" },
        body: "{}",
      });
      expect(crossOrigin.status).toBe(403);
      const started = await post("start", original);
      expect(started.status).toBe(200);
      const setup = Option.getOrNull(decodeSetup(await started.json()));
      if (!setup) throw new Error("Expected enrollment setup");
      const pending = responseCookies(original, started);
      const challenge = pending
        .split("; ")
        .find((pair) => pair.startsWith("__Host-executor-admin-challenge="));
      if (!challenge) throw new Error("Expected pending challenge cookie");
      const crossUser = await fetch(new URL("/api/auth/admin-mfa/verify", target.baseUrl), {
        method: "POST",
        headers: {
          ...other.headers,
          origin: new URL(target.baseUrl).origin,
          "content-type": "application/json",
          cookie: `${other.headers?.cookie ?? ""}; ${challenge}`,
        },
        body: JSON.stringify({ code: new TOTP({ secret: setup.secret }).generate() }),
      });
      expect(crossUser.status).toBe(400);
      const verified = await post("verify", pending, new TOTP({ secret: setup.secret }).generate());
      expect(verified.status).toBe(200);
      const verifiedCookies = responseCookies(pending, verified);
      const status = await fetch(new URL("/api/auth/admin-mfa", target.baseUrl), {
        headers: { ...headers, cookie: verifiedCookies },
      });
      expect(await status.json()).toMatchObject({ state: "verified" });
      expect(
        (await post("verify", pending, new TOTP({ secret: setup.secret }).generate())).status,
      ).toBe(400);

      // A later verification uses the existing factor and never returns its secret.
      const repeat = await post("start", original);
      expect(await repeat.json()).toEqual({ kind: "challenge" });
      const repeated = await post(
        "verify",
        responseCookies(original, repeat),
        new TOTP({ secret: setup.secret }).generate(),
      );
      expect(repeated.status).toBe(200);
    });
  }),
);

scenario(
  "Admin MFA API · restarting enrollment cannot reset the rate limit",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const identity = yield* target.newIdentity({ adminMfa: false });
    yield* Effect.promise(async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await fetch(new URL("/api/auth/admin-mfa/start", target.baseUrl), {
          method: "POST",
          headers: {
            ...identity.headers,
            origin: new URL(target.baseUrl).origin,
            "content-type": "application/json",
          },
          body: "{}",
        });
        statuses.push(response.status);
        await response.text();
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    });
  }),
);

scenario(
  "Admin MFA API · locks administration without blocking personal API access",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const locked = yield* target.newIdentity({ adminMfa: false });
    const unlocked = yield* verifyAdmin(target.baseUrl, locked);
    yield* Effect.promise(async () => {
      const send = (
        headers: Readonly<Record<string, string>> | undefined,
        method: string,
        path: string,
        body?: unknown,
      ) =>
        fetch(new URL(path, target.baseUrl), {
          method,
          headers: {
            ...headers,
            origin: new URL(target.baseUrl).origin,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const adminReads = ["/api/account/org-api-keys", "/api/admin/users", "/api/org/domains"];
      for (const path of adminReads) {
        expect((await send(locked.headers, "GET", path)).status, path).toBe(403);
        expect((await send(unlocked.headers, "GET", path)).status, path).toBe(200);
      }
      for (const [method, path, body] of [
        ["PATCH", "/api/account/name", { name: "Unauthorized rename" }],
        ["POST", "/api/auth/delete-organization", { confirmName: "Unauthorized deletion" }],
        ["DELETE", "/api/account/members/om_unknown", undefined],
        ["PATCH", "/api/account/members/om_unknown/role", { roleSlug: "admin" }],
        [
          "POST",
          "/api/account/members/invite",
          { email: "blocked@example.test", roleSlug: "admin" },
        ],
        ["POST", "/api/account/org-api-keys", { name: "blocked" }],
        ["POST", "/api/billing/openCustomerPortal", {}],
        ["POST", "/api/billing/attach", {}],
        ["POST", "/api/org/domains/verify-link", {}],
        ["POST", "/api/policies", { owner: "org", pattern: "blocked.*", action: "approve" }],
      ] as const) {
        expect((await send(locked.headers, method, path, body)).status, path).toBe(403);
      }
      const renamed = await send(unlocked.headers, "PATCH", "/api/account/name", {
        name: "Verified test workspace",
      });
      expect(renamed.status).toBe(200);
      const keyResponse = await send(locked.headers, "POST", "/api/account/api-keys", {
        name: "Personal access",
      });
      const key = decodeKey(await keyResponse.json());
      try {
        const bearer = { authorization: `Bearer ${key.value}` };
        expect((await send(bearer, "GET", "/api/integrations")).status).toBe(200);
        expect(
          (
            await send(bearer, "POST", "/api/policies", {
              owner: "org",
              pattern: "blocked.*",
              action: "approve",
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await send({ ...unlocked.headers, ...bearer }, "POST", "/api/policies", {
              owner: "org",
              pattern: "blocked.*",
              action: "approve",
            })
          ).status,
        ).toBe(403);
        expect(
          (await send({ ...unlocked.headers, ...bearer }, "GET", "/api/admin/users")).status,
        ).toBe(403);
      } finally {
        expect(
          (await send(locked.headers, "DELETE", `/api/account/api-keys/${key.id}`)).status,
        ).toBe(200);
      }
      const lock = await send(unlocked.headers, "POST", "/api/auth/admin-mfa/lock", {});
      expect(lock.status).toBe(200);
      const headers = {
        ...unlocked.headers,
        cookie: responseCookies(unlocked.headers?.cookie ?? "", lock),
      };
      for (const path of adminReads)
        expect((await send(headers, "GET", path)).status, path).toBe(403);
      expect((await send(headers, "GET", "/api/integrations")).status).toBe(200);
      expect((await send(headers, "GET", "/api/account/api-keys")).status).toBe(200);
    });
  }),
);
