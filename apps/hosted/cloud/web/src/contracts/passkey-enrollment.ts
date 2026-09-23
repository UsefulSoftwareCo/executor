import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { AuthFailed, authRequest } from "@executor-js/hosted-web/contracts/auth";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { passkeyEnrollmentCookie } from "../../../src/contracts/passkey-enrollment.ts";
import { cloudAuthClient } from "./auth.ts";

/** Enrollment is a sign-in concern; no cookie means the flow has nothing to do. */
export const hasPasskeyEnrollment = (userId: string) =>
  document.cookie
    .split(";")
    .some(
      (cookie) => cookie.trim() === `${passkeyEnrollmentCookie.name}=${encodeURIComponent(userId)}`,
    );
const clearEnrollment = (userId: string) =>
  Effect.sync(() => {
    if (hasPasskeyEnrollment(userId))
      document.cookie = `${passkeyEnrollmentCookie.name}=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });

/** Only the browser that created this account offers enrollment, until dismissed. */
export const passkeyEnrollmentAtom = Atom.family((userId: string) =>
  BrowserAtoms.atom(
    Effect.gen(function* () {
      const pending = yield* Effect.sync(() => hasPasskeyEnrollment(userId));
      if (!pending) return false;
      const supported = yield* Effect.sync(
        () => window.isSecureContext && typeof window.PublicKeyCredential !== "undefined",
      );
      if (!supported) {
        yield* clearEnrollment(userId);
        return false;
      }
      const keys = yield* authRequest((options) =>
        cloudAuthClient.passkey.listUserPasskeys({}, options),
      ).pipe(Effect.withSpan("ui.auth.passkeys"));
      if (keys === null)
        return yield* Effect.fail(new AuthFailed({ message: "Unable to check your passkeys." }));
      if (keys.length > 0) {
        yield* clearEnrollment(userId);
        return false;
      }
      return true;
    }),
  ),
);

/** Dismissal survives reloads and sign-ins; no server schema or reminders are needed. */
export const dismissPasskeyEnrollmentAtom = BrowserAtoms.fn((userId: string, get) =>
  clearEnrollment(userId).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(passkeyEnrollmentAtom(userId)))),
  ),
);
