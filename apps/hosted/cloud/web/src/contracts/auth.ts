import { observeBrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { dashboardAuthClientOptions } from "@executor-js/ui/contracts/http";
import { emailOTPClient } from "better-auth/client/plugins";
import { authRequest } from "@executor-js/hosted-web/contracts/auth";
import { Effect, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { acknowledge, acknowledgedQuery, invalidate } from "@executor-js/ui/contracts/mutations";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { AccountFailed } from "@executor-js/hosted-web/contracts/account";
import { keepFragment, signInCallback } from "@executor-js/hosted-web/contracts/navigation";
import { startSsoSignIn } from "./sso.ts";

/** Keep the submitting form mounted until the server selects the next document. */
export const finishCloudSignIn = (redirect: string) =>
  window.location.replace(keepFragment(signInCallback(redirect)));

/** Cloud-only credentials; shared session queries use the same origin and cookie. */
export const cloudAuthClient = createAuthClient({
  ...dashboardAuthClientOptions,
  plugins: [passkeyClient(), emailOTPClient()],
});
/** Prefer verified company SSO; send a code only when the server confirms no SSO connection. */
export const beginEmailSignInAtom = BrowserAtoms.fn(
  (input: { readonly email: string; readonly redirect: string }) =>
    startSsoSignIn(input).pipe(
      Effect.as("sso" as const),
      Effect.catch((error) =>
        error.code === "SSO_NOT_CONFIGURED" && error.status === 404
          ? authRequest((options) =>
              cloudAuthClient.emailOtp.sendVerificationOtp(
                { email: input.email.trim(), type: "sign-in" },
                options,
              ),
            ).pipe(Effect.as("email-code" as const))
          : Effect.fail(error),
      ),
      Effect.withSpan("ui.auth.beginEmailSignIn"),
    ),
);
/** Successful code verification also proves email ownership. */
export const verifyCodeAtom = BrowserAtoms.fn(
  (input: { email: string; otp: string; redirect: string }) =>
    authRequest((options) =>
      cloudAuthClient.signIn.emailOtp({ email: input.email, otp: input.otp }, options),
    ).pipe(
      Effect.withSpan("ui.auth.signIn"),
      Effect.tap(() => Effect.sync(() => finishCloudSignIn(input.redirect))),
      Effect.asVoid,
    ),
);
/**
 * The host whose passkeys stopped working when the dashboard moved off it, sent with each
 * server-rendered document. Null where the dashboard has not moved.
 */
export const formerPasskeyHostAtom = Atom.make<string | null>(null).pipe(
  Atom.serializable({ key: "cloud:former-passkey-host", schema: Schema.NullOr(Schema.String) }),
  Atom.keepAlive,
);
/** Start the browser's WebAuthn ceremony only after an explicit click. */
export const passkeySignInAtom = BrowserAtoms.fn((redirect: string) =>
  authRequest((options) => cloudAuthClient.signIn.passkey({}, options)).pipe(
    Effect.withSpan("ui.auth.signIn"),
    Effect.tap(() => Effect.sync(() => finishCloudSignIn(redirect))),
    Effect.asVoid,
  ),
);
/** A registered passkey; the credential itself never leaves the authenticator. */
export const PasskeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  deviceType: Schema.String,
  backedUp: Schema.Boolean,
  createdAt: Schema.Date,
});
export type PasskeySummary = typeof PasskeySummary.Type;
const passkeysQuery = BrowserAtoms.atom(
  authRequest((options) => cloudAuthClient.passkey.listUserPasskeys({}, options)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PasskeySummary))),
    Effect.mapError(() => new AccountFailed({ message: "Unable to load your passkeys." })),
    Effect.withSpan("ui.auth.passkeys"),
  ),
).pipe(revalidated);
/** The signed-in user's passkeys, for the account security page. */
export const passkeysAtom = acknowledgedQuery(passkeysQuery);
/** Register with the server's configured origin and relying-party identity. */
export const addPasskeyAtom = BrowserAtoms.fn((name: string, get) =>
  authRequest((options) => cloudAuthClient.passkey.addPasskey({ name }, options)).pipe(
    (work) => observeBrowserUsage("auth", "add_passkey", work),
    Effect.tap(() => Effect.sync(() => invalidate(get, passkeysAtom))),
    Effect.withSpan("ui.auth.addPasskey"),
    Effect.asVoid,
  ),
);
/** Remove one passkey; the row leaves the list once the server confirms. */
export const deletePasskeyAtom = Atom.family((id: string) =>
  BrowserAtoms.fn((_: void, get) =>
    authRequest((options) => cloudAuthClient.passkey.deletePasskey({ id }, options)).pipe(
      (work) => observeBrowserUsage("auth", "delete_passkey", work),
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, passkeysAtom, (current) => current.filter((key) => key.id !== id)),
        ),
      ),
      Effect.withSpan("ui.auth.deletePasskey"),
      Effect.asVoid,
    ),
  ),
);
