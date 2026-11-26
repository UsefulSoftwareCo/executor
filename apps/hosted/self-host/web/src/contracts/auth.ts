import { signInCallback } from "@executor-js/hosted-web/contracts/navigation";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { AuthFailed, authRequest, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { createAuthClient } from "better-auth/client";
import { browserOnly, dashboardAuthClientOptions } from "@executor-js/ui/contracts/http";
import { Effect, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { SignInSettings } from "./document.ts";
import { invalidate } from "@executor-js/ui/contracts/mutations";

const authClient = createAuthClient({ ...dashboardAuthClientOptions });

const liveConfiguration = browserOnly(
  BrowserAtoms.atom(
    authRequest((options) => authClient.$fetch<unknown>("/self-host/config", options)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SignInSettings)),
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new AuthFailed({ message: "Unable to load sign-in settings. Reload to try again." }),
        ),
      ),
    ),
  ),
);

const entryConfiguration = Atom.make<Option.Option<SignInSettings>>(Option.none()).pipe(
  Atom.serializable({ key: "self-host:sign-in-settings", schema: Schema.Option(SignInSettings) }),
  Atom.keepAlive,
);

export const configurationAtom = Atom.readable(
  (get) => {
    const entry = get(entryConfiguration);
    return Option.isSome(entry)
      ? AsyncResult.success<SignInSettings, AuthFailed>(entry.value)
      : get(liveConfiguration);
  },
  (refresh) => {
    refresh(entryConfiguration);
    refresh(liveConfiguration);
  },
);

export const signInInitialValues = (settings: SignInSettings | null) =>
  settings === null ? [] : [Atom.initialValue(entryConfiguration, Option.some(settings))];

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

const LinkedAccounts = Schema.Array(Schema.Struct({ providerId: Schema.String }));

export const ssoConnectedAtom = browserOnly(
  BrowserAtoms.atom(
    authRequest((options) => authClient.listAccounts({}, options)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LinkedAccounts)),
      Effect.map((accounts) => accounts.some((account) => account.providerId === "sso")),
      Effect.catchTag("SchemaError", () =>
        Effect.fail(new AuthFailed({ message: "Unable to read your sign-in methods." })),
      ),
      Effect.withSpan("ui.auth.sso_connected"),
    ),
  ),
);

export const connectSsoAtom = BrowserAtoms.fn(() =>
  authRequest((options) =>
    authClient.linkSocial(
      {
        provider: "sso",
        callbackURL: "/account/security",
        errorCallbackURL: "/account/security",
      },
      options,
    ),
  ).pipe(Effect.withSpan("ui.auth.connect_sso"), Effect.asVoid),
);
