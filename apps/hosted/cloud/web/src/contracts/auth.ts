import { observeBrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { dashboardAuthClientOptions } from "@executor-js/ui/contracts/http";
import { emailOTPClient } from "better-auth/client/plugins";
import { AuthFailed, authRequest, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { Effect, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { acknowledge, acknowledgedQuery, invalidate } from "@executor-js/ui/contracts/mutations";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { AccountFailed } from "@executor-js/hosted-web/contracts/account";
import { keepFragment, signInCallback } from "@executor-js/hosted-web/contracts/navigation";
import { startSsoSignIn } from "./sso.ts";

export const finishCloudSignIn = (redirect: string) =>
  window.location.replace(keepFragment(signInCallback(redirect)));

export const cloudAuthClient = createAuthClient({
  ...dashboardAuthClientOptions,
  plugins: [passkeyClient(), emailOTPClient()],
});
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
export const formerPasskeyHostAtom = Atom.make<string | null>(null).pipe(
  Atom.serializable({ key: "cloud:former-passkey-host", schema: Schema.NullOr(Schema.String) }),
  Atom.keepAlive,
);
export const passkeySignInAtom = BrowserAtoms.fn((redirect: string) =>
  authRequest((options) => cloudAuthClient.signIn.passkey({}, options)).pipe(
    Effect.withSpan("ui.auth.signIn"),
    Effect.tap(() => Effect.sync(() => finishCloudSignIn(redirect))),
    Effect.asVoid,
  ),
);
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
export const passkeysAtom = acknowledgedQuery(passkeysQuery);
export const addPasskeyAtom = BrowserAtoms.fn((name: string, get) =>
  authRequest((options) => cloudAuthClient.passkey.addPasskey({ name }, options)).pipe(
    (work) => observeBrowserUsage("auth", "add_passkey", work),
    Effect.tap(() => Effect.sync(() => invalidate(get, passkeysAtom))),
    Effect.withSpan("ui.auth.addPasskey"),
    Effect.asVoid,
  ),
);
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
const emailChangeFailure = (error: AuthFailed) =>
  error.code === "SSO_MANAGED_EMAIL"
    ? new AuthFailed({
        code: error.code,
        message:
          "Your organization's SSO connection manages your email. Ask an administrator to change it.",
      })
    : error;
export const sendEmailChangeApprovalAtom = BrowserAtoms.fn((email: string) =>
  authRequest((options) =>
    cloudAuthClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" }, options),
  ).pipe(Effect.withSpan("ui.auth.sendEmailChangeApproval"), Effect.asVoid),
);
export const requestEmailChangeAtom = BrowserAtoms.fn(
  (input: { readonly newEmail: string; readonly otp: string }) =>
    authRequest((options) => cloudAuthClient.emailOtp.requestEmailChange(input, options)).pipe(
      Effect.mapError(emailChangeFailure),
      Effect.withSpan("ui.auth.requestEmailChange"),
      Effect.asVoid,
    ),
);
export const changeEmailAtom = BrowserAtoms.fn(
  (input: { readonly newEmail: string; readonly otp: string }, get) =>
    authRequest((options) => cloudAuthClient.emailOtp.changeEmail(input, options)).pipe(
      (work) => observeBrowserUsage("auth", "change_email", work),
      Effect.mapError(emailChangeFailure),
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, sessionAtom, (current) =>
            current === null
              ? current
              : { ...current, user: { ...current.user, email: input.newEmail.toLowerCase() } },
          ),
        ),
      ),
      Effect.withSpan("ui.auth.changeEmail"),
      Effect.asVoid,
    ),
);
