import { hostCookieName } from "@executor-js/hosted-server/browser/contracts";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { authOptions, singleResourceOrigin } from "@executor-js/hosted-server";
import { Effect, Option, Redacted, Schema } from "effect";

export { LoopbackOrigin as TestOrigin } from "@executor-js/utils/url-policy";

export const FixtureName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/u));

export class TestAccountFailed extends Schema.TaggedError<TestAccountFailed>()(
  "TestAccountFailed",
  {
    stage: Schema.Literals(["configuration", "database", "fixture", "output"]),
  },
) {}

export const DevtoolsOperatorId = "executor-devtools-operator";

const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });
const Member = Schema.Struct({ role: Schema.String });

export const testAccountAuth = (settings: {
  readonly origin: string;
  readonly secret: Redacted.Redacted<string>;
  readonly cookiePrefix: string;
  readonly database: BetterAuthOptions["database"];
}) => {
  const base = authOptions(
    {
      url: settings.origin,
      resourceOrigins: singleResourceOrigin(settings.origin),
      issuer: `${settings.origin}/api/auth`,
      oauthRedirectUri: Option.none(),
    },
    [],
  );
  const helpers = testUtils();
  return betterAuth({
    ...base,
    database: settings.database,
    secret: Redacted.value(settings.secret),
    advanced: {
      ...base.advanced,
      cookiePrefix: hostCookieName(settings.origin, settings.cookiePrefix),
    },
    session: { ...base.session, expiresIn: 3600 },
    plugins: [
      ...base.plugins,
      organization({ disableOrganizationDeletion: true }),
      {
        ...helpers,
        init(ctx: Parameters<typeof helpers.init>[0]) {
          const { options, ...result } = helpers.init(ctx);
          return { ...result, ...(options === undefined ? {} : { options }) };
        },
      },
    ],
  });
};

export const provisionTestAccount = (
  auth: ReturnType<typeof testAccountAuth>,
  input: {
    readonly host: "self-host" | "cloud";
    readonly name: string;
    readonly displayName?: string;
    readonly organization: string;
    readonly role: "owner" | "admin" | "member";
    readonly origin: string;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const ctx = await auth.$context;
      const test = ctx.test;
      if (!test.createOrganization || !test.saveOrganization || !test.addMember)
        throw new Error("Organization helpers unavailable");
      const organizations = await ctx.adapter.findMany({
        model: "organization",
        ...(input.host === "cloud"
          ? { where: [{ field: "slug", value: input.organization }] }
          : {}),
        limit: 2,
      });
      if (organizations.length > 1) throw new Error("Ambiguous organization");
      const existing = organizations[0];
      const organization = Schema.decodeUnknownSync(Organization)(
        existing === undefined
          ? await test.saveOrganization(
              test.createOrganization({ name: "Agent tests", slug: input.organization }),
            )
          : existing,
      );
      if (organization.slug !== input.organization)
        throw new Error("Self-host organization mismatch");
      const email = `agent-${input.name}@example.test`;
      const found = await ctx.internalAdapter.findUserByEmail(email);
      let user =
        found === null
          ? await test.saveUser(
              test.createUser({
                email,
                name: input.displayName ?? `Agent ${input.name}`,
                emailVerified: true,
              }),
            )
          : found.user;
      if (input.displayName !== undefined && user.name === `Agent ${input.name}`) {
        user = await ctx.internalAdapter.updateUser(user.id, { name: input.displayName });
      }
      const member = await ctx.adapter.findOne({
        model: "member",
        where: [
          { field: "userId", value: user.id },
          { field: "organizationId", value: organization.id },
        ],
      });
      if (member === null) {
        await test.addMember({
          userId: user.id,
          organizationId: organization.id,
          role: input.role,
        });
      } else if (Schema.decodeUnknownSync(Member)(member).role !== input.role) {
        throw new Error("Existing fixture role differs");
      }
      const login = await test.login({ userId: user.id });
      const cookie = login.headers.get("cookie");
      if (cookie === null) throw new Error("Session cookie missing");
      return Redacted.make({
        origin: input.origin,
        dashboardUrl: `${input.origin}/org/${organization.slug}/apps`,
        userId: user.id,
        name: user.name,
        email,
        organizationId: organization.id,
        organizationSlug: organization.slug,
        role: input.role,
        expiresAt: login.session.expiresAt.toISOString(),
        headers: { cookie },
        cookies: login.cookies,
      });
    },
    catch: () => new TestAccountFailed({ stage: "fixture" }),
  });
