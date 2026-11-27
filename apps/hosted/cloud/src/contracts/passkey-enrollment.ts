import { hostCookieName } from "@executor-js/hosted-server/browser/contracts";

export const passkeyEnrollmentCookie = {
  name: (origin: string) => hostCookieName(origin, "executor_passkey_enrollment"),
  attributes: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 60 * 60 * 24 * 365 },
} as const;
