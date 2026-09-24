import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TOTP } from "otpauth";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { verifyAdmin, responseCookies } from "./support/admin-mfa";

const decodeKey = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, value: Schema.String }),
);

const decodeUsers = Schema.decodeUnknownSync(
  Schema.Struct({ users: Schema.Array(Schema.Struct({ email: Schema.NullOr(Schema.String) })) }),
);

const decodeSetup = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal("enroll"), secret: Schema.String }),
);

scenario(
  "Admin MFA API · requires same-origin requests and binds verification to the session",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const identity = yield* target.newIdentity();
    const other = yield* target.newIdentity();
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
    const identity = yield* target.newIdentity();
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
  "Organization key MFA · issued keys retain backend access while management is locked",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const locked = yield* target.newIdentity();
    const unlocked = yield* verifyAdmin(target.baseUrl, locked);
    const other = yield* target.newIdentity();
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
      for (const path of [
        "/api/admin/users",
        "/api/org/domains",
        "/api/account/members",
        "/api/policies",
      ]) {
        expect((await send(locked.headers, "GET", path)).status, path).toBe(200);
      }
      expect(
        (
          await send(locked.headers, "PATCH", "/api/account/name", {
            name: "Minimal MFA workspace",
          })
        ).status,
      ).toBe(200);
      expect((await send(locked.headers, "GET", "/api/account/org-api-keys")).status).toBe(403);
      expect(
        (await send(locked.headers, "POST", "/api/account/org-api-keys", { name: "Blocked mint" }))
          .status,
      ).toBe(403);
      const minted = await send(unlocked.headers, "POST", "/api/account/org-api-keys", {
        name: "Backend reader",
      });
      expect(minted.status).toBe(200);
      const key = decodeKey(await minted.json());
      try {
        expect(
          (await send(locked.headers, "DELETE", `/api/account/org-api-keys/${key.id}`)).status,
        ).toBe(403);
        const lock = await send(unlocked.headers, "POST", "/api/auth/admin-mfa/lock", {});
        expect(lock.status).toBe(200);
        const headers = {
          ...unlocked.headers,
          cookie: responseCookies(unlocked.headers?.cookie ?? "", lock),
        };
        expect((await send(headers, "GET", "/api/account/org-api-keys")).status).toBe(403);
        const email = locked.credentials?.email;
        if (!email) throw new Error("Test identity has no email");
        // Server-to-server requests have no browser cookie or interactive factor.
        const bearer = { authorization: `Bearer ${key.value}` };
        for (const path of [
          "/api/admin/users",
          `/api/admin/users/with-connections?email=${encodeURIComponent(email)}`,
        ]) {
          const result = await send(bearer, "GET", path);
          expect(result.status, path).toBe(200);
          const body = decodeUsers(await result.json());
          expect(body.users.map((user) => user.email)).toContain(email);
        }
        expect((await send(bearer, "GET", "/api/account/org-api-keys")).status).toBe(401);
        const proof = unlocked.headers?.cookie
          ?.split("; ")
          .find((pair) => pair.startsWith("__Host-executor-admin-mfa="));
        if (!proof) throw new Error("Test verification returned no cookie");
        expect(
          (
            await send(
              { ...other.headers, cookie: `${other.headers?.cookie}; ${proof}` },
              "POST",
              "/api/account/org-api-keys",
              { name: "Cross-user mint" },
            )
          ).status,
        ).toBe(403);
      } finally {
        expect(
          (await send(unlocked.headers, "DELETE", `/api/account/org-api-keys/${key.id}`)).status,
        ).toBe(200);
      }
      expect(
        (await send({ authorization: `Bearer ${key.value}` }, "GET", "/api/admin/users")).status,
      ).toBe(401);
    });
  }),
);
