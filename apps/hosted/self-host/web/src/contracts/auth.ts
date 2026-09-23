import { signInCallback } from "@executor-js/hosted-web/contracts/navigation";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { AuthFailed, authRequest, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { createAuthClient } from "better-auth/client";
import { Effect, Schema } from "effect";
import { invalidate } from "@executor-js/ui/contracts/mutations";

/** Self-host sign-in methods do not expose the shared organization's native client. */
const authClient = createAuthClient();

/** The server exposes only setup availability and whether the operator enabled SSO. */
export const configurationAtom = BrowserAtoms.atom(
  authRequest((options) => authClient.$fetch<unknown>("/self-host/config", options)).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Struct({ setup: Schema.Boolean, sso: Schema.Boolean })),
    ),
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new AuthFailed({ message: "Unable to load sign-in settings. Reload to try again." }),
      ),
    ),
  ),
);

/** Explicit self-host credential flow selected by the user. */
export type SelfHostSignIn =
  | { readonly kind: "login"; readonly email: string; readonly password: string }
  | {
      readonly kind: "setup";
      readonly name: string;
      readonly email: string;
      readonly password: string;
      readonly organizationName: string;
    }
  | {
      readonly kind: "invite";
      readonly name: string;
      readonly email: string;
      readonly password: string;
      readonly invitation: string;
    }
  | { readonly kind: "sso"; readonly redirect: string };

/** Complete one sign-in flow; registration policy stays on the server. */
export const selfHostSignInAtom = BrowserAtoms.fn((input: SelfHostSignIn, get) => {
  const action =
    input.kind === "login"
      ? authRequest((options) => authClient.signIn.email(input, options))
      : input.kind === "sso"
        ? authRequest((options) =>
            authClient.signIn.social(
              {
                provider: "sso",
                callbackURL: signInCallback(input.redirect),
                errorCallbackURL: `/login?redirect=${encodeURIComponent(input.redirect)}`,
              },
              options,
            ),
          )
        : authRequest((options) =>
            authClient.$fetch(input.kind === "setup" ? "/self-host/setup" : "/self-host/register", {
              ...options,
              method: "POST",
              body: input,
            }),
          );
  return action.pipe(
    Effect.withSpan(`ui.auth.${input.kind}`),
    Effect.tap(() =>
      Effect.sync(() => {
        invalidate(get, sessionAtom);
        get.refresh(configurationAtom);
      }),
    ),
    Effect.asVoid,
  );
});
