import { sso } from "@better-auth/sso";
import type { AuthContext, BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { getCurrentAdapter } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { Option, Schema } from "effect";
import type { CloudBillingHooks } from "./auth-options.ts";

const Provider = Schema.Struct({
  providerId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
  domain: Schema.NonEmptyString,
  domainVerified: Schema.Boolean,
});
const ProviderId = Schema.String.check(Schema.isPattern(/^sso-[a-z0-9-]{1,32}$/));
const Domain = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
);
const Registration = Schema.Struct({
  organizationId: Schema.NonEmptyString,
  providerId: ProviderId,
  domain: Domain,
});

const invalid = () => new APIError("BAD_REQUEST", { message: "Invalid SSO configuration." });
const parse = <A>(schema: Schema.Decoder<A>, value: unknown): A =>
  Option.getOrThrowWith(Schema.decodeUnknownOption(schema)(value), invalid);

const callbackProvider = (context: GenericEndpointContext | null) => {
  if (!context?.path || !/^\/sso\/(?:callback|saml2\/sp\/acs)\//.test(context.path))
    return undefined;
  return typeof context.params?.providerId === "string" ? context.params.providerId : undefined;
};

/** Only a validated SSO callback for a DNS-verified email domain can verify an email. */
export const ssoVerifiedEmail = async (
  email: string,
  context: GenericEndpointContext | null,
): Promise<boolean> => {
  const providerId = callbackProvider(context);
  if (providerId === undefined || context === null) return false;
  const database = await getCurrentAdapter(context.context.adapter);
  const row = await database.findOne({
    model: "ssoProvider",
    where: [{ field: "providerId", value: providerId }],
  });
  const provider = parse(Provider, row);
  // A provider may assert only the exact domain its administrator proved. A
  // contractor signs in through their own verified identity and an invitation.
  if (!provider.domainVerified || email.toLowerCase().split("@")[1] !== provider.domain)
    throw new APIError("FORBIDDEN", {
      message: "Your email does not belong to this SSO connection's verified domain.",
    });
  return true;
};

/**
 * Native SAML/OIDC protocol handling, with cloud-owned tenancy and encrypted
 * configuration. Each auth instance owns its key; nothing survives its scope.
 * Domain verification is a prerequisite for sign-in and account linking.
 */
export const cloudSso = (billing?: CloudBillingHooks) => {
  let secret: AuthContext["secretConfig"] | undefined;
  let auth: AuthContext | undefined;
  const configurationTransform = {
    input: async (value: unknown) => {
      if (value === null || value === undefined) return null;
      if (typeof value !== "string" || secret === undefined) throw invalid();
      return symmetricEncrypt({ key: secret, data: value });
    },
    output: async (value: unknown) => {
      if (value === null || value === undefined) return null;
      if (typeof value !== "string" || secret === undefined) throw invalid();
      return symmetricDecrypt({ key: secret, data: value });
    },
  };
  const native = sso({
    domainVerification: { enabled: true },
    // The native JIT insert bypasses billing and concurrent membership checks.
    organizationProvisioning: { disabled: true },
    resolveUser: async (input, { database }) => {
      const provider = parse(
        Provider,
        await database.findOne({
          model: "ssoProvider",
          where: [{ field: "providerId", value: input.providerId }],
        }),
      );
      const account = await database.findOne({
        model: "account",
        where: [
          { field: "providerId", value: input.providerId },
          { field: "accountId", value: input.accountKey.accountId },
        ],
      });
      const linkedUser =
        account === null
          ? null
          : parse(
              Schema.Struct({ email: Schema.String }),
              await database.findOne({
                model: "user",
                where: [
                  {
                    field: "id",
                    value: parse(Schema.Struct({ userId: Schema.String }), account).userId,
                  },
                ],
              }),
            );
      // An old account link cannot cross the verified domain after a connection
      // changes domain or its former team is deleted and its ID is reused.
      return provider.domainVerified &&
        input.providerUser.email.toLowerCase().split("@")[1] === provider.domain &&
        (linkedUser === null || linkedUser.email.toLowerCase().split("@")[1] === provider.domain)
        ? { action: "continue" }
        : {
            action: "reject",
            code: "SSO_EMAIL_DOMAIN_MISMATCH",
            message: "Use an email from the connection's verified domain.",
          };
    },
    provisionUserOnEveryLogin: true,
    provisionUser: async ({ user, provider: row }) => {
      if (auth === undefined) throw invalid();
      const provider = parse(Provider, row);
      // Resolve the external allowance before opening the membership transaction.
      const limit =
        billing === undefined ? undefined : await billing.memberLimit(provider.organizationId);
      await auth.adapter.transaction(async (database) => {
        // All SSO connections for this team share a lock. Updating the primary
        // key to itself changes no team data and serializes JIT retries.
        const team = await database.update({
          model: "organization",
          where: [{ field: "id", value: provider.organizationId }],
          update: { id: provider.organizationId },
        });
        if (!team) throw invalid();
        if (
          await database.findOne({
            model: "member",
            where: [
              { field: "organizationId", value: provider.organizationId },
              { field: "userId", value: user.id },
            ],
          })
        )
          return;
        // An explicit invitation owns its role and must still be accepted.
        if (
          await database.findOne({
            model: "invitation",
            where: [
              { field: "organizationId", value: provider.organizationId },
              { field: "email", value: user.email.toLowerCase() },
              { field: "status", value: "pending" },
              { field: "expiresAt", value: new Date(), operator: "gt" },
            ],
          })
        )
          return;
        const count = await database.count({
          model: "member",
          where: [{ field: "organizationId", value: provider.organizationId }],
        });
        if (limit !== undefined && count >= limit)
          throw new APIError("FORBIDDEN", {
            message: "This team has no available seats. Contact your team administrator.",
          });
        await database.create({
          model: "member",
          data: {
            organizationId: provider.organizationId,
            userId: user.id,
            role: "member",
            createdAt: new Date(),
          },
        });
      });
    },
    saml: {
      enableInResponseToValidation: true,
      allowIdpInitiated: false,
      requireTimestamps: true,
      algorithms: { onDeprecated: "reject" },
    },
  });
  // The package's declaration omits the standard lifecycle members from its
  // inferred return type. Read them through Better Auth's public plugin contract.
  const lifecycle: BetterAuthPlugin = native;
  return {
    ...native,
    init: (context: AuthContext) => {
      secret = context.secretConfig;
      auth = context;
      return lifecycle.init?.(context);
    },
    schema: {
      ...native.schema,
      ssoProvider: {
        ...native.schema.ssoProvider,
        fields: {
          ...native.schema.ssoProvider.fields,
          oidcConfig: {
            type: "string" as const,
            required: false,
            transform: configurationTransform,
          },
          samlConfig: {
            type: "string" as const,
            required: false,
            transform: configurationTransform,
          },
          organizationId: {
            type: "string" as const,
            required: true,
            unique: true,
            references: { model: "organization", field: "id", onDelete: "cascade" as const },
          },
          // The team owns the connection after creation. Removing its original
          // administrator must not remove SSO for the remaining members.
          userId: {
            type: "string" as const,
            required: false,
            references: { model: "user", field: "id", onDelete: "set null" as const },
          },
        },
      },
    },
    hooks: {
      before: [
        ...(lifecycle.hooks?.before ?? []),
        {
          matcher: (context: { path?: string }) => context.path === "/sign-in/sso",
          handler: createAuthMiddleware(async (context) => {
            const input = parse(
              Schema.Struct({
                email: Schema.optionalKey(Schema.String),
                providerId: Schema.optionalKey(Schema.String),
              }),
              context.body,
            );
            if (input.providerId !== undefined || input.email === undefined) return;
            const email = parse(
              Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
              input.email.trim().toLowerCase(),
            );
            const domain = parse(Domain, email.split("@")[1]);
            // Native discovery chooses the first matching row, including pending
            // connections. Only one verified exact-domain match is unambiguous.
            const providers = parse(
              Schema.Array(Schema.Struct({ providerId: ProviderId })),
              await context.context.adapter.findMany({
                model: "ssoProvider",
                where: [
                  { field: "domain", value: domain },
                  { field: "domainVerified", value: true },
                ],
                limit: 2,
              }),
            );
            const provider = providers[0];
            if (provider === undefined)
              throw new APIError("NOT_FOUND", {
                code: "SSO_NOT_CONFIGURED",
                message: "SSO is not available for this email domain.",
              });
            if (providers.length !== 1)
              throw new APIError("CONFLICT", {
                code: "SSO_DOMAIN_AMBIGUOUS",
                message: "More than one SSO connection uses this email domain.",
              });
            return { context: { body: { email, providerId: provider.providerId } } };
          }),
        },
        {
          matcher: (context: { path?: string }) =>
            context.path?.startsWith("/sso/saml2/sp/acs/") === true,
          handler: createAuthMiddleware(async (context) => {
            // Native SAML skips this check to accommodate Lax cookies. Cloud
            // uses a dedicated Secure/SameSite=None cookie so another browser
            // cannot submit a valid assertion and sign the victim into its user.
            const { RelayState } = parse(
              Schema.Struct({ RelayState: Schema.NonEmptyString }),
              context.body,
            );
            const cookie = context.context.createAuthCookie("relay_state");
            if ((await context.getSignedCookie(cookie.name, context.context.secret)) !== RelayState)
              throw new APIError("FORBIDDEN", { message: "Start SSO again in this browser." });
          }),
        },
        {
          matcher: (context: { path?: string }) =>
            context.path === "/sso/register" || context.path === "/sso/update-provider",
          handler: createAuthMiddleware(async (context) => {
            if (context.path === "/sso/register") {
              parse(Registration, context.body);
              // Native registration checks current owner/admin membership too.
              const body = parse(
                Schema.Struct({
                  oidcConfig: Schema.optionalKey(Schema.Unknown),
                  samlConfig: Schema.optionalKey(Schema.Unknown),
                }),
                context.body,
              );
              if ((body.oidcConfig === undefined) === (body.samlConfig === undefined))
                throw invalid();
            } else {
              const body = parse(
                Schema.Struct({ domain: Schema.optionalKey(Domain) }),
                context.body,
              );
              if (body.domain !== undefined) parse(Domain, body.domain);
            }
          }),
        },
      ],
      // Native SSO also assigns membership after ordinary social sign-in by
      // domain. Cloud only grants it after the bound SSO provider authenticated.
      after: [
        {
          matcher: (context: { path?: string }) => context.path === "/sso/register",
          handler: createAuthMiddleware(async (context) => {
            if (context.context.returned instanceof APIError) return;
            const response = parse(
              Schema.Struct({
                providerId: Schema.String,
                organizationId: Schema.String,
                issuer: Schema.String,
                domain: Schema.String,
                domainVerified: Schema.Boolean,
                domainVerificationToken: Schema.String,
                redirectURI: Schema.String,
                samlConfig: Schema.NullOr(Schema.Unknown),
              }),
              context.context.returned,
            );
            // Library errors retain their status. Successful registration never
            // echoes the submitted client secret or SAML private keys.
            const { samlConfig, ...publicFields } = response;
            return context.json({ ...publicFields, type: samlConfig === null ? "oidc" : "saml" });
          }),
        },
      ],
    },
  };
};
