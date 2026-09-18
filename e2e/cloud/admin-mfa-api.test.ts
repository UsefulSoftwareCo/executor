import { expect } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { TOTP } from "otpauth";
import { scenario } from "../src/scenario";
import { Target } from "../src/services";
import { responseCookies } from "./support/admin-mfa";

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
      expect(unverifiedWorkspace.status).toBe(403);
      expect(await unverifiedWorkspace.json()).toMatchObject({ code: "admin_mfa_required" });
      const key = await fetch(new URL("/api/account/api-keys", target.baseUrl), {
        method: "POST",
        headers: { ...headers, origin: new URL(target.baseUrl).origin },
        body: JSON.stringify({ name: "unverified-admin" }),
      });
      expect(key.status).toBe(403);
      const billing = await fetch(new URL("/api/billing/customer", target.baseUrl), { headers });
      expect(billing.status).toBe(403);
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
