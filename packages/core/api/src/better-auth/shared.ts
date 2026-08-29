import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, bearer, deviceAuthorization, mcp, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";

const SIGNUP_PATH = "/sign-up/email";

export interface BetterAuthDbClient {
  execute(sql: string, args?: any[]): Promise<{ rows: any[]; rowsAffected?: number }>;
}

export interface SignupGate {
  readonly organizationId: string;
  readonly getAuth: () => BetterAuthInstance | null;
  readonly findRedeemableCode: (
    code: string,
  ) => Promise<{ role: "admin" | "member"; expiresAt: string | null } | null>;
  readonly consumeInviteCode: (
    code: string,
    by: { usedBy: string; usedByEmail: string },
  ) => Promise<boolean>;
}

export const getSharedPlugins = () => [
  organization({ allowUserToCreateOrganization: false }),
  admin(),
  apiKey({ enableSessionForAPIKeys: true, rateLimit: { enabled: false } }),
  bearer(),
  deviceAuthorization({ verificationUri: "/device" }),
  mcp({
    loginPage: "/login",
    oidcConfig: { loginPage: "/login", consentPage: "/mcp-consent" },
  }),
];

const dummyOptions = {
  plugins: getSharedPlugins(),
};

export type BetterAuthInstance = ReturnType<typeof betterAuth<typeof dummyOptions>>;

export const inviteCodeFrom = (context: { body?: unknown }): string | undefined => {
  const body = context.body;
  if (body && typeof body === "object" && "inviteCode" in body) {
    const code = (body as { inviteCode?: unknown }).inviteCode;
    if (typeof code === "string" && code.trim().length > 0) return code;
  }
  return undefined;
};

export const countOrgMembers = (
  auth: BetterAuthInstance,
  organizationId: string,
): Promise<number> =>
  auth.$context.then(({ adapter }) =>
    adapter.count({ model: "member", where: [{ field: "organizationId", value: organizationId }] }),
  );

const orgHasNoMembers = async (gate: SignupGate): Promise<boolean> => {
  const auth = gate.getAuth();
  if (!auth) return true;
  return (await countOrgMembers(auth, gate.organizationId)) === 0;
};

let warnedInsecureTrustedOrigin = false;

export const makeBetterAuthSharedOptions = (
  getOrganizationId: () => string,
  config: {
    authSecret: string;
    webBaseUrl?: string;
    trustedOrigins?: readonly string[];
  },
  gate?: SignupGate,
) => {
  const origins =
    config.trustedOrigins && config.trustedOrigins.length > 0
      ? [...config.trustedOrigins]
      : config.webBaseUrl
        ? [config.webBaseUrl]
        : [];

  const hasInsecureTrustedOrigin = origins.some((origin) => origin && origin.startsWith("http://"));
  const downgradesCanonicalCookies =
    hasInsecureTrustedOrigin && !!config.webBaseUrl && config.webBaseUrl.startsWith("https://");
  if (downgradesCanonicalCookies && !warnedInsecureTrustedOrigin) {
    warnedInsecureTrustedOrigin = true;
    console.warn(
      "[executor] EXECUTOR_TRUSTED_ORIGINS contains an http:// origin, so session cookies drop the Secure attribute for every origin — including the https:// canonical URL. Use https:// aliases to keep session cookies transport-secure.",
    );
  }

  const secret = config.authSecret;
  if (secret.length < 32) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a multi-user auth server must not boot with a weak session secret
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET), if set, must be at least 32 characters");
  }

  return {
    secret,
    ...(config.webBaseUrl ? { baseURL: config.webBaseUrl } : {}),
    ...(origins.length > 0 ? { trustedOrigins: origins } : {}),
    advanced: { useSecureCookies: !hasInsecureTrustedOrigin },
    emailAndPassword: { enabled: true },
    plugins: getSharedPlugins(),
    databaseHooks: {
      session: {
        create: {
          before: async (session: Record<string, unknown>) => ({
            data: { ...session, activeOrganizationId: getOrganizationId() },
          }),
        },
      },
      ...(gate
        ? {
            user: {
              create: {
                before: async (_user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  if (await orgHasNoMembers(gate)) return;
                  const code = inviteCodeFrom(context);
                  if (!code) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Better Auth hook rejects by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "An invite code is required to sign up.",
                    });
                  }
                  const redeemable = await gate.findRedeemableCode(code);
                  if (!redeemable) {
                    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Better Auth hook rejects by throwing APIError
                    throw new APIError("FORBIDDEN", {
                      message: "That invite code is invalid, already used, or expired.",
                    });
                  }
                },
                after: async (user, context) => {
                  if (context?.path !== SIGNUP_PATH) return;
                  const auth = gate.getAuth();
                  if (!auth) return;
                  if (await orgHasNoMembers(gate)) {
                    await auth.api.addMember({
                      body: { userId: user.id, role: "owner", organizationId: gate.organizationId },
                    });
                    return;
                  }
                  const code = inviteCodeFrom(context);
                  if (!code) return;
                  const redeemable = await gate.findRedeemableCode(code);
                  if (!redeemable) return;
                  await auth.api.addMember({
                    body: {
                      userId: user.id,
                      role: redeemable.role,
                      organizationId: gate.organizationId,
                    },
                  });
                  await gate.consumeInviteCode(code, {
                    usedBy: user.id,
                    usedByEmail: user.email,
                  });
                },
              },
            },
          }
        : {}),
    },
  } satisfies BetterAuthOptions;
};
