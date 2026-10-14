/** Cloud sign-in policy; self-hosted deployments do not need these OAuth credentials. */
import { siteVisitorCookie } from "@executor-js/marketing/site-visitor";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { authOptions, type RefreshRejection } from "@executor-js/hosted-server";
import { cloudHosts } from "../infrastructure/stage.ts";
import { passkey } from "@better-auth/passkey";
import { emailOTP } from "better-auth/plugins/email-otp";
import { organization } from "better-auth/plugins/organization";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { oauthProxyLocationGuard, oauthProxyProductionGuard } from "./oauth-proxy-guard.ts";
import {
  cloudAccountRedirectUri,
  cloudOAuthProxy,
  socialCallbackOrigin,
} from "./oauth-proxy-settings.ts";
import type { SendAuthEmail } from "../contracts/email.ts";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { emailCodeExpiresIn, emailCodeMessage, invitationEmailMessage } from "./email-messages.ts";
import { nativeAuthAnalytics, type NativeAuthUsage } from "./auth-analytics.ts";
import { passkeyEnrollmentCookie } from "../contracts/passkey-enrollment.ts";
import { cloudEmulators } from "../infrastructure/emulators.ts";
import { emulatedSocialProviders } from "./emulated-auth.ts";
import { cloudSso, ssoVerifiedEmail } from "./sso.ts";
import { chatGptSettings, chatGptSignIn } from "./chatgpt-sign-in.ts";
import { cloudMemberLimit } from "./member-limit.ts";

/** The better-auth endpoint that creates accounts from a verified email code. */
const emailCodeSignInPath = "/sign-in/email-otp";

/** Require both cloud social providers and reject blank credentials at startup. */
export const cloudAuthSettings = Effect.gen(function* () {
  const hosts = yield* cloudHosts;
  const url = hosts.browser;
  const resourceOrigins = hosts.resourceOrigins;
  const callbackOrigin = socialCallbackOrigin(hosts);
  const emulators = yield* cloudEmulators;
  const oauthRedirectUri = yield* cloudAccountRedirectUri;
  const { names: proxyNames, settings: oauthProxy } = yield* cloudOAuthProxy;
  // The proxy's production is where its sign-ins return. A value naming this deployment's other
  // hosts is stale configuration: production would proxy its own sign-ins to itself. The browser
  // origin moves with `CLOUD_BROWSER_ORIGIN`; the callback origin does not, so neither does this.
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

/** Promise boundary used by Better Auth's organization lifecycle. */
export interface CloudBillingHooks {
  readonly memberLimit: (organization: string) => Promise<number>;
}

/**
 * Keep the passkey relying-party identity pinned to the configured hosts. The caller decides the
 * per-address limit with `cloudAuthRateLimit`.
 */
export const cloudAuthOptions = (
  settings: Effect.Success<typeof cloudAuthSettings> & { readonly rateLimitEnabled: boolean },
  ipAddressHeaders: string[],
  send: SendAuthEmail,
  billing?: CloudBillingHooks,
  onSignup?: (userId: string) => Promise<void>,
  onLogin?: (userId: string) => Promise<void>,
  onOperation?: (usage: NativeAuthUsage) => Promise<void>,
  allowsOrganization?: (userId: string) => Promise<boolean>,
  onRefreshRejected?: (rejection: RefreshRejection) => void,
) => {
  const base = authOptions(settings, ipAddressHeaders, onRefreshRejected);
  // A test stage that signs in through production's proxy uses production's callback, which the
  // proxy sets. Every other deployment names its own social callback origin explicitly.
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
        // SAML returns through a cross-site POST. Keep its browser binding
        // cookie available without changing any session cookie's SameSite policy.
        relay_state: { attributes: { sameSite: "none" as const, secure: true } },
      },
    },
    trustedOrigins: [...base.trustedOrigins, ...settings.trustedOrigins],
    user: {
      // Better Auth stores a provider photo only when it creates the user. This is the one
      // hook that sees a returning or newly linked provider's verified profile, so keep the
      // photo current here. Name and email stay as they are, and a provider without a photo
      // never clears one. Accepts every identity; a failed write must not block sign-in.
      // ChatGPT never joins an existing account by email. The rejection is returned, not
      // thrown: Better Auth replaces anything thrown here with a generic validation failure.
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
                if (source.method !== "oauth" || source.action === "create-user") return;
                if (typeof id !== "string" || typeof image !== "string" || image.length === 0)
                  return;
                const adapter = context.context.internalAdapter;
                const current = yield* Effect.tryPromise(() => adapter.findUserById(id));
                if (!current || current.image === image) return;
                yield* Effect.tryPromise(() => adapter.updateUser(id, { image }));
              }).pipe(
                Effect.catch((error) =>
                  Effect.sync(() =>
                    context.context.logger.warn("Unable to refresh the provider photo", error),
                  ),
                ),
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
          // Consume the site visitor identity on every successful sign-in, including returning
          // users. It must never be linked to a second account later.
          after: async (session, context) => {
            if (onLogin !== undefined) await onLogin(session.userId);
            if (!context) return;
            context.setCookie(siteVisitorCookie, "", {
              path: "/",
              maxAge: 0,
              sameSite: "lax",
              secure: new URL(settings.url).protocol === "https:",
              ...Option.match(settings.hosts.sharedCookieDomain, {
                onNone: () => ({}),
                onSome: (domain) => ({ domain }),
              }),
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
            ...redirectURI("google"),
            clientId: settings.googleClientId,
            clientSecret: Redacted.value(settings.googleClientSecret),
            includeGrantedScopes: false,
          },
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
      //
      // The plugin proxies a sign-in unless the request's origin is its production URL. Production
      // is the edge (`executor.sh`), but its own sign-ins start on the browser origin (`app.`, or
      // `v2.` under the rollback switch), so the plugin would proxy them to a completion endpoint
      // the guard refuses. Production names itself as the current URL instead: every sign-in it
      // starts is its own and returns through the edge directly. It still exchanges the codes of
      // proxied sign-ins, which the plugin recognizes by their encrypted state, not by origin.
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
        // Team setup's v1 decision also governs Better Auth's own create endpoint, so a
        // signed-in account that belongs on Executor v1 cannot create a v2 organization here.
        ...(allowsOrganization === undefined
          ? {}
          : { allowUserToCreateOrganization: (user) => allowsOrganization(user.id) }),
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
      // The native migrator creates tables in plugin order; SSO references organization.
      cloudSso(billing),
      emailOTP({
        storeOTP: "hashed",
        expiresIn: emailCodeExpiresIn,
        allowedAttempts: 3,
        // A signed-in session alone cannot move the account: the current address approves the
        // change with its own code, then the new address proves ownership with another.
        changeEmail: { enabled: true, verifyCurrentEmail: true },
        // Better Auth sends sign-in codes to new emails too; their first code creates the account.
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
      // The relying party is the role hosts' domain (`executor.sh`), so passkeys survive a later
      // move of the dashboard between hosts under it. Ceremonies run on the browser origin.
      passkey({
        rpID: settings.hosts.passkey.rpId,
        rpName: "Executor",
        origin: settings.hosts.passkey.origin,
      }),
    ],
  };
};
