import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";

const completionPaths = new Set(["/callback/:id/oauth-proxy", "/oauth-proxy-callback"]);

const redirectFields = ["callbackURL", "errorURL", "newUserURL"] as const;

const badState = (message: string) => new APIError("BAD_REQUEST", { message });

export const isProxyStatePackage = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "isOAuthProxy" in value &&
  Boolean(value.isOAuthProxy) &&
  "state" in value &&
  Boolean(value.state) &&
  "stateCookie" in value &&
  Boolean(value.stateCookie);

const redirectOrigin = (value: string, field: string): string | undefined => {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return undefined;
  const target = URL.parse(value);
  if (target === null || (target.protocol !== "https:" && target.protocol !== "http:"))
    throw badState(`OAuth proxy ${field} is not a usable redirect.`);
  return target.origin;
};

export const proxyRedirectOrigins = (stateData: unknown): ReadonlyArray<string> => {
  if (typeof stateData !== "object" || stateData === null)
    throw badState("OAuth proxy state is missing its redirect.");
  const state = stateData as Record<string, unknown>;
  if (typeof state["callbackURL"] !== "string" || state["callbackURL"].length === 0)
    throw badState("OAuth proxy state is missing its redirect.");
  const origins = new Set<string>();
  for (const field of redirectFields) {
    const value = state[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length === 0)
      throw badState(`OAuth proxy ${field} is not a usable redirect.`);
    const origin = redirectOrigin(value, field);
    if (origin !== undefined) origins.add(origin);
  }
  const nested = URL.parse(state["callbackURL"])?.searchParams.get("callbackURL");
  if (nested !== null && nested !== undefined && nested.length > 0) {
    const origin = redirectOrigin(nested, "nested callbackURL");
    if (origin !== undefined) origins.add(origin);
  }
  return [...origins];
};

const proxiedRedirectOrigins = async (
  secret: string,
  state: unknown,
): Promise<ReadonlyArray<string> | undefined> => {
  if (typeof state !== "string" || state.length === 0) return undefined;
  let statePackage: unknown;
  try {
    statePackage = JSON.parse(await symmetricDecrypt({ key: secret, data: state }));
  } catch {
    return undefined;
  }
  if (!isProxyStatePackage(statePackage)) return undefined;
  const stateCookie = (statePackage as { stateCookie: unknown }).stateCookie;
  if (typeof stateCookie !== "string") throw badState("OAuth proxy state cannot be read.");
  let stateData: unknown;
  try {
    stateData = JSON.parse(await symmetricDecrypt({ key: secret, data: stateCookie }));
  } catch {
    throw badState("OAuth proxy state cannot be read.");
  }
  return proxyRedirectOrigins(stateData);
};

export const oauthProxyProductionGuard = (secret: string) =>
  ({
    id: "executor-oauth-proxy-production-guard",
    hooks: {
      before: [
        {
          matcher: (context) => context.path !== undefined && completionPaths.has(context.path),
          handler: createAuthMiddleware(async () => {
            throw new APIError("NOT_FOUND");
          }),
        },
        {
          matcher: (context) => context.path === "/callback/:id",
          handler: createAuthMiddleware(async (context) => {
            const origins = await proxiedRedirectOrigins(
              secret,
              context.query?.state ?? context.body?.state,
            );
            if (origins === undefined) return;
            for (const origin of origins)
              if (!context.context.isTrustedOrigin(origin))
                throw new APIError("FORBIDDEN", {
                  message: "OAuth proxy redirect target is not a trusted origin.",
                });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

export const oauthProxyLocationGuard = () =>
  ({
    id: "executor-oauth-proxy-location-guard",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/callback/:id",
          handler: createAuthMiddleware(async (context) => {
            const location = context.context.responseHeaders?.get("location");
            if (location === null || location === undefined) return;
            const target = URL.parse(location);
            if (target === null || context.context.isTrustedOrigin(target.origin)) return;
            context.setHeader("location", "/");
            throw new APIError("FORBIDDEN", {
              message: "OAuth redirect target is not a trusted origin.",
            });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
