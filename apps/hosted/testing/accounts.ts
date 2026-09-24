/** Privileged fixture helpers. Imported only by local test tooling, never a host entry point. */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { authOptions } from "@executor-js/hosted-server";
import { Effect, Option, Redacted, Schema } from "effect";

/** Local provisioning must never target a public origin. */
export { LoopbackOrigin as TestOrigin } from "@executor-js/utils/url-policy";

/** Stable fixture names are also valid organization slugs and synthetic email components. */
export const FixtureName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/));

/** Sanitized failures keep database credentials and session cookies out of diagnostics. */
export class TestAccountFailed extends Schema.TaggedError<TestAccountFailed>()(
  "TestAccountFailed",
  {
    stage: Schema.Literals(["configuration", "database", "fixture", "output"]),
  },
) {}

/** Synthetic platform admin used only by the loopback development bootstrap. */
export const DevtoolsOperatorId = "executor-devtools-operator";

const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });
const Member = Schema.Struct({ role: Schema.String });

/** Compose a separate fixture auth instance using the product's schema and signed-cookie defaults.
 * Admission hooks intentionally belong to the real login server, not this privileged test process.
 */
export const testAccountAuth = (settings: {
  readonly origin: string;
  readonly secret: Redacted.Redacted<string>;
  readonly cookiePrefix: string;
  readonly database: BetterAuthOptions["database"];
}) => {
  const base = authOptions({ url: settings.origin, oauthRedirectUri: Option.none() }, []);
  const helpers = testUtils();
  return betterAuth({
    ...base,
    database: settings.database,
    secret: Redacted.value(settings.secret),
    advanced: { ...base.advanced, cookiePrefix: settings.cookiePrefix },
    session: { ...base.session, expiresIn: 3600 },
    plugins: [
      ...base.plugins,
      {
        ...helpers,
        // Better Auth 1.7.5 emits options: undefined; omit it for exact optional property types.
        init(ctx: Parameters<typeof helpers.init>[0]) {
          const { options, ...result } = helpers.init(ctx);
          return { ...result, ...(options === undefined ? {} : { options }) };
        },
      },
    ],
  });
};

/** Reuse a named synthetic fixture without changing its role; issue a fresh one-hour session.
 * A partial failure can be retried with the same names. Self-host never adds a second organization.
 */
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
              test.createOrganization({
                // Cloud onboarding owns organization creation and uses UUIDs.
                // Match its IDs so fixture SQL binds have the same wire size.
                ...(input.host === "cloud" ? { id: crypto.randomUUID() } : {}),
                name: "Agent tests",
                slug: input.organization,
              }),
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
      // Rename only the generated fixture label; keep edited profiles and stable user identities.
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
