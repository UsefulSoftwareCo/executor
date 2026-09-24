import { describe, expect, it } from "@effect/vitest";
import { SignJWT, jwtVerify } from "jose";
import { workosAccessTokenOptions } from "./access-token-options";

describe("WorkOS token age boundary", () => {
  it("accepts a fresh token, rejects it after 24 hours, and rejects future issuance", async () => {
    const key = new TextEncoder().encode("synthetic-signing-key-for-unit-test-only");
    const issuedAt = 1_700_000_000;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 7 * 86400)
      .sign(key);
    await expect(
      jwtVerify(token, key, {
        ...workosAccessTokenOptions,
        currentDate: new Date((issuedAt + 86399) * 1000),
      }),
    ).resolves.toHaveProperty("payload.iat", issuedAt);
    await expect(
      jwtVerify(token, key, {
        ...workosAccessTokenOptions,
        currentDate: new Date((issuedAt + 86401) * 1000),
      }),
    ).rejects.toHaveProperty("code", "ERR_JWT_EXPIRED");
    await expect(
      jwtVerify(token, key, {
        ...workosAccessTokenOptions,
        currentDate: new Date((issuedAt - 1) * 1000),
      }),
    ).rejects.toHaveProperty("code", "ERR_JWT_CLAIM_VALIDATION_FAILED");
  });
});
