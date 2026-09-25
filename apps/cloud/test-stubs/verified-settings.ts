import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { ADMIN_MFA_COOKIE, signAdminMfaProof } from "../src/auth/admin-mfa-proof";

/** A signed proof for HTTP fixtures; the WorkOS stub must return this session id. */
export const verifiedSettingsCookie = async (userId: string): Promise<string> => {
  const now = Date.now();
  const proof = await Effect.runPromise(
    signAdminMfaProof(
      env.WORKOS_COOKIE_PASSWORD,
      { userId, sessionId: "test-settings-session" },
      "verified",
      {
        factorId: "test-factor",
        challengeId: "test-challenge",
        mode: "challenge",
        exp: now / 1000 + 900,
      },
      now,
    ),
  );
  return `${ADMIN_MFA_COOKIE}=${proof}`;
};
