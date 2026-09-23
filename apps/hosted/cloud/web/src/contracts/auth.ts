import { observeBrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { authRequest } from "@executor-js/hosted-web/contracts/auth";
import { Effect } from "effect";
import { signInCallback } from "@executor-js/hosted-web/contracts/navigation";
import { startSsoSignIn } from "./sso.ts";

/** Keep the submitting form mounted until the server selects the next document. */
export const finishCloudSignIn = (redirect: string) =>
  window.location.replace(signInCallback(redirect));

/** Cloud-only credentials; shared session queries use the same origin and cookie. */
export const cloudAuthClient = createAuthClient({ plugins: [passkeyClient(), emailOTPClient()] });
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
/** Start the browser's WebAuthn ceremony only after an explicit click. */
export const passkeySignInAtom = BrowserAtoms.fn((redirect: string) =>
  authRequest((options) => cloudAuthClient.signIn.passkey({}, options)).pipe(
    Effect.withSpan("ui.auth.signIn"),
    Effect.tap(() => Effect.sync(() => finishCloudSignIn(redirect))),
    Effect.asVoid,
  ),
);
/** Register with the server's configured origin and relying-party identity. */
export const addPasskeyAtom = BrowserAtoms.fn((name: string) =>
  authRequest((options) => cloudAuthClient.passkey.addPasskey({ name }, options)).pipe(
    (work) => observeBrowserUsage("auth", "add_passkey", work),
    Effect.withSpan("ui.auth.addPasskey"),
    Effect.asVoid,
  ),
);
