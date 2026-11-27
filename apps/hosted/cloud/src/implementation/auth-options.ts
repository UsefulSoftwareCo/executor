import { siteVisitorCookie } from "@executor-js/marketing/site-visitor";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { authOptions, type GrantObservers } from "@executor-js/hosted-server";
import { cloudHosts } from "../infrastructure/stage.ts";
import { passkey } from "@better-auth/passkey";
import { emailOTP } from "better-auth/plugins/email-otp";
import { signInOriginCookie } from "@executor-js/hosted-server/sign-in-origin";
import { organization } from "better-auth/plugins/organization";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { oauthProxyLocationGuard, oauthProxyProductionGuard } from "./oauth-proxy-guard.ts";
import {
  cloudAccountRedirectUri,
  cloudOAuthProxy,
  socialCallbackOrigin,
} from "./oauth-proxy-settings.ts";
import type { SendAuthEmail } from "../contracts/email.ts";
import type { ProviderPhotoRefresh } from "./auth-observability.ts";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { google, type GoogleOptions } from "better-auth/social-providers";
import { emailCodeExpiresIn, emailCodeMessage, invitationEmailMessage } from "./email-messages.ts";
import { nativeAuthAnalytics, type NativeAuthUsage } from "./auth-analytics.ts";
import { passkeyEnrollmentCookie } from "../contracts/passkey-enrollment.ts";
import { cloudEmulators } from "../infrastructure/emulators.ts";
import { emulatedSocialProviders } from "./emulated-auth.ts";
import { cloudSso, ssoVerifiedEmail } from "./sso.ts";
import { chatGptSettings, chatGptSignIn } from "./chatgpt-sign-in.ts";
import { cloudMemberLimit } from "./member-limit.ts";
import { v1HandoffSessions } from "./v1-session-handoff.ts";

const emailCodeSignInPath = "/sign-in/email-otp";

export const cloudAuthSettings = Effect.gen(function* () {
  const hosts = yield* cloudHosts;
  const url = hosts.browser;
  const resourceOrigins = hosts.resourceOrigins;
  const callbackOrigin = socialCallbackOrigin(hosts);
  const emulators = yield* cloudEmulators;
  const oauthRedirectUri = yield* cloudAccountRedirectUri;
  const { names: proxyNames, settings: oauthProxy } = yield* cloudOAuthProxy;
  if (
    Option.isSome(oauthProxy) &&
    oauthProxy.value.productionUrl !== callbackOrigin &&
    [hosts.deployment, hosts.browser].includes(oauthProxy.value.productionUrl)
  )
    return yield* Effect.die(
      new Error(
        `${proxyNames.productionUrl} is ${oauthProxy.value.productionUrl}, this deployment's own origin; set it to ${callbackOrigin}, where its social sign-ins return`,
      ),
    );
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
  return {
    url,
    hosts,
    resourceOrigins,
    issuer: hosts.issuer,
    callbackOrigin,
    oauthRedirectUri,
    oauthProxy,
    trustedOrigins,
    emulators,
    ...social,
    chatGpt: yield* chatGptSettings,
  };
});

const GoogleUserInfo = Schema.Struct({
  sub: Schema.String,
  picture: Schema.optional(Schema.String),
});

const withGooglePhoto = (options: GoogleOptions): GoogleOptions => {
  const provider = google(options);
  return {
    ...options,
    getUserInfo: async (tokens) => {
      const info = await provider.getUserInfo(tokens);
      const accessToken = tokens.accessToken;
      if (info === null || info.user.image || accessToken === undefined) return info;
      const picture = await Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* HttpClient.get(
            "https://openidconnect.googleapis.com/v1/userinfo",
            {
              headers: { authorization: `Bearer ${accessToken}` },
            },
          );
          if (response.status !== 200) return undefined;
          const userInfo = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(GoogleUserInfo)),
          );
          return userInfo.sub === info.data.sub ? userInfo.picture : undefined;
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      );
      return picture ? { ...info, user: { ...info.user, image: picture } } : info;
    },
  };
};

export interface CloudBillingHooks {
  readonly memberLimit: (organization: string) => Promise<number>;
}

export const cloudAuthOptions = (
  settings: Effect.Success<typeof cloudAuthSettings> & { readonly rateLimitEnabled: boolean },
  ipAddressHeaders: string[],
  send: SendAuthEmail,
  billing?: CloudBillingHooks,
  onSignup?: (userId: string) => Promise<void>,
  onLogin?: (userId: string) => Promise<void>,
  onOperation?: (usage: NativeAuthUsage) => Promise<void>,
  grants?: GrantObservers,
  onProviderPhoto?: (refresh: ProviderPhotoRefresh) => void,
) => {
  const base = authOptions(settings, ipAddressHeaders, grants);
  const proxiedElsewhere = Option.exists(
    settings.oauthProxy,
    (proxy) => proxy.productionUrl !== settings.callbackOrigin,
  );
  const redirectURI = (provider: "google" | "github") =>
    proxiedElsewhere
      ? {}
      : { redirectURI: `${settings.callbackOrigin}/api/auth/callback/${provider}` };
  return {
    ...base,
    rateLimit: { ...base.rateLimit, enabled: settings.rateLimitEnabled },
    account: { ...base.account, storeStateStrategy: "database" as const },
    advanced: {
      ...base.advanced,
      cookies: {
        relay_state: { attributes: { sameSite: "none" as const, secure: true } },
      },
    },
    trustedOrigins: [...base.trustedOrigins, ...settings.trustedOrigins],
    user: {
      validateUserInfo: ({ user, source }, context) =>
        source.method === "oauth" &&
        source.oauth?.providerId === "openai" &&
        source.action === "link-account"
          ? Promise.resolve({
              error: "account_not_linked",
              errorDescription: "Sign in with your existing method before linking ChatGPT.",
            })
          : Effect.runPromise(
              Effect.gen(function* () {
                const { id, image } = user;
                if (source.method !== "oauth") return;
                if (source.action === "create-user") return "new_user" as const;
                if (typeof image !== "string" || image.length === 0) return "absent" as const;
                if (typeof id !== "string") return "user_missing" as const;
                const adapter = context.context.internalAdapter;
                const current = yield* Effect.tryPromise(() => adapter.findUserById(id));
                if (!current) return "user_missing" as const;
                if (current.image === image) return "unchanged" as const;
                yield* Effect.tryPromise(() => adapter.updateUser(id, { image }));
                return "updated" as const;
              }).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    context.context.logger.warn("Unable to refresh the provider photo", error);
                    return "failed" as const;
                  }),
                ),
                Effect.map((refresh) => {
                  if (refresh !== undefined) onProviderPhoto?.(refresh);
                }),
              ),
            ),
    } satisfies BetterAuthOptions["user"],
    databaseHooks: {
      account: {
        create: {
          before: async (account) =>
            account.providerId === "openai"
              ? { data: { ...account, idToken: null, accessToken: null, refreshToken: null } }
              : undefined,
        },
        update: {
          before: async (account, context) =>
            context?.params?.id === "openai" || context?.body?.provider === "openai"
              ? { data: { ...account, idToken: null, accessToken: null, refreshToken: null } }
              : undefined,
        },
      },
      user: {
        create: {
          before: async (user, context) =>
            (await ssoVerifiedEmail(user.email, context))
              ? { data: { ...user, emailVerified: true } }
              : undefined,
          after: async (user, context) => {
            if (user.emailVerified && onSignup !== undefined) await onSignup(user.id);
            return Effect.runPromise(
              Effect.sync(() => {
                if (context?.path !== emailCodeSignInPath) return;
                context.setCookie(passkeyEnrollmentCookie.name(settings.url), user.id, {
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
          after: async (session, context) => {
            if (onLogin !== undefined) await onLogin(session.userId);
            if (!context) return;
            context.setCookie(siteVisitorCookie(settings.url), "", {
              path: "/",
              maxAge: 0,
              sameSite: "lax",
              secure: new URL(settings.url).protocol === "https:",
            });
            context.setCookie(signInOriginCookie, "", {
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
          google: withGooglePhoto({
            ...redirectURI("google"),
            clientId: settings.googleClientId,
            clientSecret: Redacted.value(settings.googleClientSecret),
            includeGrantedScopes: false,
            prompt: "select_account" as const,
          }),
          github: {
            ...redirectURI("github"),
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
      ...Option.match(settings.chatGpt, {
        onSome: (configuration) => [chatGptSignIn(configuration, settings.callbackOrigin)],
        onNone: () => [],
      }),
      ...(onOperation === undefined ? [] : [nativeAuthAnalytics(onOperation)]),
      ...Option.match(settings.emulators, {
        onSome: (services) => [emulatedSocialProviders(services, redirectURI)],
        onNone: () => [],
      }),
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
      ...Option.match(settings.oauthProxy, {
        onSome: (proxy) => {
          const secret = Redacted.value(proxy.secret);
          const production = proxy.productionUrl === settings.callbackOrigin;
          return [
            ...(production ? [oauthProxyProductionGuard(secret)] : []),
            oAuthProxy({
              productionURL: proxy.productionUrl,
              ...(production ? { currentURL: proxy.productionUrl } : {}),
              secret,
            }),
            oauthProxyLocationGuard(),
          ];
        },
        onNone: () => [],
      }),
      ...base.plugins,
      organization({
        ...(billing === undefined
          ? {}
          : {
              membershipLimit: (_user, organization) => billing.memberLimit(organization.id),
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
      ...(billing === undefined ? [] : [cloudMemberLimit(billing)]),
      v1HandoffSessions(),
      cloudSso(billing),
      emailOTP({
        storeOTP: "hashed",
        expiresIn: emailCodeExpiresIn,
        allowedAttempts: 3,
        changeEmail: { enabled: true, verifyCurrentEmail: true },
        sendVerificationOTP: async (data, ctx) => {
          const signUp =
            data.type === "sign-in" &&
            ctx !== undefined &&
            (await ctx.context.internalAdapter.findUserByEmail(data.email)) === null;
          await Effect.runPromise(
            send(emailCodeMessage({ ...data, type: signUp ? "sign-up" : data.type })),
          );
        },
      }),
      passkey({
        rpID: settings.hosts.passkey.rpId,
        rpName: "Executor",
        origin: settings.hosts.passkey.origin,
      }),
    ],
  };
};
