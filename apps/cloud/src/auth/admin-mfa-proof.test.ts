import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { readAdminMfaProof, signAdminMfaProof } from "./admin-mfa-proof";

const secret = "a-test-only-cookie-password-of-32-characters";
const identity = { userId: "user_test", sessionId: "session_test" };
const now = 1_800_000_000_000;
const proof = {
  mode: "challenge" as const,
  factorId: "factor_test",
  challengeId: "challenge_test",
  exp: now / 1000 + 900,
};
const signed = signAdminMfaProof(secret, identity, "verified", proof, now);

describe("admin verification cookie", () => {
  it.effect("accepts a valid proof for the same user and session", () =>
    Effect.gen(function* () {
      const token = yield* signed;
      expect(yield* readAdminMfaProof(secret, identity, "verified", token, now)).toEqual(proof);
    }),
  );

  it.effect("refuses missing, modified, and unsigned cookies", () =>
    Effect.gen(function* () {
      const token = yield* signed;
      const parts = token.split(".");
      const unsigned = `${btoa('{"alg":"none"}')}.${parts[1]}.`;
      for (const value of [
        undefined,
        "",
        "bad.cookie",
        `${token.slice(0, 50)}x${token.slice(51)}`,
        unsigned,
      ]) {
        expect(yield* readAdminMfaProof(secret, identity, "verified", value, now)).toBeNull();
      }
    }),
  );

  it.effect("refuses another session, another user, and another signing key", () =>
    Effect.gen(function* () {
      const token = yield* signed;
      for (const other of [
        { ...identity, userId: "other" },
        { ...identity, sessionId: "other" },
      ]) {
        expect(yield* readAdminMfaProof(secret, other, "verified", token, now)).toBeNull();
      }
      expect(
        yield* readAdminMfaProof(`${secret}-rotated`, identity, "verified", token, now),
      ).toBeNull();
    }),
  );

  it.effect("cannot promote an unfinished challenge to verified access", () =>
    Effect.gen(function* () {
      const token = yield* signAdminMfaProof(
        secret,
        identity,
        "challenge",
        { ...proof, mode: "enroll", exp: now / 1000 + 300 },
        now,
      );
      expect(yield* readAdminMfaProof(secret, identity, "verified", token, now)).toBeNull();
      expect(
        yield* readAdminMfaProof(secret, identity, "challenge", token, now + 299_000),
      ).not.toBeNull();
      expect(
        yield* readAdminMfaProof(secret, identity, "challenge", token, now + 300_000),
      ).toBeNull();
    }),
  );

  it.effect("honors the signed expiration and refuses a future-issued cookie", () =>
    Effect.gen(function* () {
      const token = yield* signed;
      expect(
        yield* readAdminMfaProof(secret, identity, "verified", token, now + 899_000),
      ).not.toBeNull();
      expect(
        yield* readAdminMfaProof(secret, identity, "verified", token, now + 900_000),
      ).toBeNull();
      expect(
        yield* readAdminMfaProof(secret, identity, "verified", token, now - 10_000),
      ).toBeNull();
    }),
  );

  it.effect("keeps the verified session unlocked beyond the former fifteen-minute window", () =>
    Effect.gen(function* () {
      const token = yield* signAdminMfaProof(
        secret,
        identity,
        "verified",
        {
          ...proof,
          exp: now / 1000 + 7 * 86400,
        },
        now,
      );
      expect(
        yield* readAdminMfaProof(secret, identity, "verified", token, now + 3600_000),
      ).not.toBeNull();
      expect(
        yield* readAdminMfaProof(secret, identity, "verified", token, now + 7 * 86400_000),
      ).toBeNull();
    }),
  );

  it.effect("caps token age even when the supplied expiration is longer", () =>
    Effect.gen(function* () {
      const token = yield* signAdminMfaProof(
        secret,
        identity,
        "verified",
        { ...proof, exp: now / 1000 + 8 * 86400 },
        now,
      );
      expect(yield* readAdminMfaProof(secret, identity, "verified", token, now)).toBeNull();
      expect(
        yield* readAdminMfaProof(secret, identity, "verified", token, now + 901_000),
      ).toBeNull();
    }),
  );

  it.effect("rejects a signed cookie with missing issued-at or another algorithm", () =>
    Effect.gen(function* () {
      for (const algorithm of ["HS256", "HS384"]) {
        const jwt = new SignJWT({ ...proof })
          .setProtectedHeader({ alg: algorithm })
          .setIssuer("executor:admin-mfa:verified")
          .setSubject(identity.userId)
          .setAudience(identity.sessionId);
        // HS256 lacks iat; HS384 is otherwise valid but outside the allowlist.
        if (algorithm === "HS384") jwt.setIssuedAt(now / 1000);
        const token = yield* Effect.promise(() => jwt.sign(new TextEncoder().encode(secret)));
        expect(yield* readAdminMfaProof(secret, identity, "verified", token, now)).toBeNull();
      }
    }),
  );
});
