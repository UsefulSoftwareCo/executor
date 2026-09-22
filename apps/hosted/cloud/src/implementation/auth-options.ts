/** Cloud sign-in policy; self-hosted deployments do not need these OAuth credentials. */
import {
  heroCookieName,
  heroPreviewCookie,
  heroVisitorCookie,
} from "@executor-js/marketing/experiments";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { authOptions } from "@executor-js/hosted-server";
import { HttpUrl } from "@executor-js/sdk/core";
import { cloudOrigin } from "../infrastructure/stage.ts";
import { passkey } from "@better-auth/passkey";
import { emailOTP } from "better-auth/plugins/email-otp";
import { organization } from "better-auth/plugins/organization";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { oauthProxyLocationGuard, oauthProxyProductionGuard } from "./oauth-proxy-guard.ts";
import type { SendAuthEmail } from "../contracts/email.ts";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { emailCodeExpiresIn, emailCodeMessage, invitationEmailMessage } from "./email-messages.ts";
import { passkeyEnrollmentCookie } from "../contracts/passkey-enrollment.ts";
import { cloudEmulators } from "../infrastructure/emulators.ts";
import { emulatedSocialProviders } from "./emulated-auth.ts";

/** The better-auth endpoint that creates accounts from a verified email code. */
const emailCodeSignInPath = "/sign-in/email-otp";

const ProxyOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
      } catch {
        return false;
      }
    },
    { message: "OAUTH_PROXY_PRODUCTION_URL must be an HTTP(S) origin without a trailing slash" },
  ),
);

/**
 * One registered OAuth client serves every stage, and its callback belongs to production.
 * A test stage needs both the production origin and the shared proxy secret, or neither.
 */
const OAuthProxySettings = Schema.Struct({
  productionUrl: Schema.Option(ProxyOrigin),
  secret: Schema.Option(Schema.Redacted(Schema.String.check(Schema.isMinLength(32)))),
}).check(
  Schema.makeFilter((value) => Option.isSome(value.productionUrl) === Option.isSome(value.secret), {
    message: "Set OAUTH_PROXY_PRODUCTION_URL and OAUTH_PROXY_SECRET together, or set neither",
  }),
);

/** Require both cloud social providers and reject blank credentials at startup. */
export const cloudAuthSettings = Effect.gen(function* () {
  const url = yield* cloudOrigin;
  const emulators = yield* cloudEmulators;
  const oauthRedirectUri = yield* Config.String("EXECUTOR_OAUTH_CALLBACK_URL").pipe(
    Config.option,
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Option(HttpUrl))),
  );
  // Emulators own direct callbacks. Do not resolve real proxy credentials in this mode,
  // including retained deployment bindings from a previous non-emulated version.
  const oauthProxy = Option.isSome(emulators)
    ? Option.none()
    : yield* Config.all({
        productionUrl: Config.String("OAUTH_PROXY_PRODUCTION_URL").pipe(Config.option),
        secret: Config.Redacted("OAUTH_PROXY_SECRET").pipe(Config.option),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OAuthProxySettings)),
        Effect.map(Option.all),
      );
  // Production must trust the stage origins it redirects signed-in profiles back to.
  const trustedOrigins = yield* Config.String("AUTH_TRUSTED_ORIGINS").pipe(
    Config.option,
    Effect.map(
      Option.match({
        onSome: (value) =>
          value
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
        onNone: (): string[] => [],
      }),
    ),
  );
  const realSocial = Config.all({
    googleClientId: Config.String("GOOGLE_CLIENT_ID"),
    googleClientSecret: Config.Redacted("GOOGLE_CLIENT_SECRET"),
    githubClientId: Config.String("GITHUB_CLIENT_ID"),
    githubClientSecret: Config.Redacted("GITHUB_CLIENT_SECRET"),
  }).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          googleClientId: Schema.NonEmptyString,
          googleClientSecret: Schema.Redacted(Schema.NonEmptyString),
          githubClientId: Schema.NonEmptyString,
          githubClientSecret: Schema.Redacted(Schema.NonEmptyString),
        }),
      ),
    ),
  );
  const social = yield* Option.match(emulators, {
    onNone: () => realSocial,
    onSome: (configuration) => {
      const { google, github } = Redacted.value(configuration);
      return Effect.succeed({
        googleClientId: google.clientId,
        googleClientSecret: Redacted.make(google.clientSecret),
        githubClientId: github.clientId,
        githubClientSecret: Redacted.make(github.clientSecret),
      });
    },
  });
  return { url, oauthRedirectUri, oauthProxy, trustedOrigins, emulators, ...social };
});

/** Promise boundary used by Better Auth's organization lifecycle. */
export interface CloudBillingHooks {
  readonly memberLimit: (organization: string) => Promise<number>;
  readonly syncSeats: (organization: string) => Promise<void>;
}

/** Keep the passkey relying-party identity pinned to the configured public origin. */
export const cloudAuthOptions = (
  settings: Effect.Success<typeof cloudAuthSettings>,
  ipAddressHeaders: string[],
  send: SendAuthEmail,
  billing?: CloudBillingHooks,
  onSignup?: (userId: string) => Promise<void>,
) => {
  const base = authOptions(settings, ipAddressHeaders);
  return {
    ...base,
    trustedOrigins: [...base.trustedOrigins, ...settings.trustedOrigins],
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => {
            if (user.emailVerified && onSignup !== undefined) await onSignup(user.id);
            return Effect.runPromise(
              Effect.sync(() => {
                // Only a new email-code account is offered a passkey. Social sign-ins
                // already have a fast path, and existing-user sign-ins never
                // recreate a dismissed prompt.
                if (context?.path !== emailCodeSignInPath) return;
                context.setCookie(passkeyEnrollmentCookie.name, user.id, {
                  ...passkeyEnrollmentCookie.attributes,
                  secure: new URL(settings.url).protocol === "https:",
                });
              }),
            );
          },
        },
      },
      session: {
        create: {
          // Consume anonymous attribution on every successful sign-in, including
          // returning users. It must never be linked to a second account later.
          after: async (_session, context) => {
            if (!context) return;
            for (const name of [heroVisitorCookie, heroCookieName, heroPreviewCookie])
              context.setCookie(name, "", {
                path: "/",
                maxAge: 0,
                sameSite: "lax",
                secure: new URL(settings.url).protocol === "https:",
              });
          },
          before: async (session, context) => {
            if (!context) throw new APIError("UNAUTHORIZED");
            const user = await context.context.internalAdapter.findUserById(session.userId);
            if (!user?.emailVerified)
              throw new APIError("FORBIDDEN", {
                message: "Verify your email by signing in with an email code.",
              });
          },
        },
      },
    } satisfies BetterAuthOptions["databaseHooks"],
    socialProviders: Option.isSome(settings.emulators)
      ? {}
      : {
          google: {
            clientId: settings.googleClientId,
            clientSecret: Redacted.value(settings.googleClientSecret),
            includeGrantedScopes: false,
          },
          github: {
            clientId: settings.githubClientId,
            clientSecret: Redacted.value(settings.githubClientSecret),
            disableDefaultScope: true,
            scope: ["user:email"],
          },
        },
    emailVerification: {
      sendVerificationEmail: ({ user, url }: { user: { email: string }; url: string }) =>
        Effect.runPromise(
          send({
            to: user.email,
            subject: "Verify your Executor email",
            text: Redacted.make(
              `Verify your email address by opening this link:\n\n${url}\n\nIf you did not request this, ignore this email.`,
            ),
          }),
        ),
    },
    plugins: [
      ...Option.match(settings.emulators, {
        onSome: (services) => [emulatedSocialProviders(services)],
        onNone: () => [],
      }),
      // Login mail is part of the request: provider rejection must reach the UI.
      // Better Auth's default background helper catches and logs these failures.
      {
        id: "executor-auth-email-delivery",
        init: () => ({
          context: {
            runInBackgroundOrAwait: async (task: void | Promise<unknown>) => {
              await task;
            },
          },
        }),
      },
      // A test stage starts the social flow with production's redirect URI; production exchanges
      // the code and returns the encrypted profile here. Production itself never proxies its own origin.
      // On production the guard runs first: it limits the return target to trusted origins and
      // refuses the completion endpoints, so the shared secret cannot mint a production session.
      // The location guard runs last, because Better Auth runs after hooks in plugin order and
      // the proxy plugin's after hook rewrites the outgoing redirect. It checks that rewrite
      // wherever the plugin is registered, not only on the origin that acts as production.
      ...Option.match(settings.oauthProxy, {
        onSome: (proxy) => [
          ...(proxy.productionUrl === settings.url
            ? [oauthProxyProductionGuard(Redacted.value(proxy.secret))]
            : []),
          oAuthProxy({ productionURL: proxy.productionUrl, secret: Redacted.value(proxy.secret) }),
          oauthProxyLocationGuard(),
        ],
        onNone: () => [],
      }),
      ...base.plugins.filter((plugin) => plugin.id !== "organization"),
      organization({
        ...(billing === undefined
          ? {}
          : {
              membershipLimit: (_user, organization) => billing.memberLimit(organization.id),
              organizationHooks: {
                afterCreateOrganization: ({ organization }) => billing.syncSeats(organization.id),
                afterAddMember: ({ organization }) => billing.syncSeats(organization.id),
                afterRemoveMember: ({ organization }) => billing.syncSeats(organization.id),
                afterAcceptInvitation: ({ organization }) => billing.syncSeats(organization.id),
              },
            }),
        disableOrganizationDeletion: true,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: ({ email, id, organization }) =>
          Effect.runPromise(
            send(
              invitationEmailMessage({
                email,
                id,
                organizationName: organization.name,
                origin: settings.url,
              }),
            ),
          ),
      }),
      emailOTP({
        storeOTP: "hashed",
        expiresIn: emailCodeExpiresIn,
        allowedAttempts: 3,
        sendVerificationOTP: (data) => Effect.runPromise(send(emailCodeMessage(data))),
      }),
      passkey({ rpID: new URL(settings.url).hostname, rpName: "Executor", origin: settings.url }),
    ],
  };
};
