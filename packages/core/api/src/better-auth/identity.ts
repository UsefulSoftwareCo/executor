import { Context, Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized } from "../server/identity";
import { type BetterAuthInstance, type BetterAuthDbClient } from "./shared";

export interface BetterAuthHandle {
  readonly auth: BetterAuthInstance;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly dbClient: BetterAuthDbClient;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthHandle>()(
  "@executor-js/api/BetterAuth",
) {}

const bearerToken = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim() || undefined
    : undefined;
};

export const betterAuthIdentityLayer: Layer.Layer<IdentityProvider, never, BetterAuth> =
  Layer.effect(IdentityProvider)(
    Effect.gen(function* () {
      const { auth, organizationId, organizationName, organizationSlug } = yield* BetterAuth;
      return IdentityProvider.of({
        authenticate: (request) =>
          Effect.gen(function* () {
            let resolved = yield* Effect.promise(() =>
              auth.api.getSession({ headers: request.headers }),
            );
            if (!resolved) {
              const token = bearerToken(request.headers);
              if (token) {
                resolved = yield* Effect.tryPromise({
                  try: () => auth.api.getSession({ headers: { "x-api-key": token } }),
                  catch: () => "api-key session lookup failed",
                }).pipe(Effect.orElseSucceed(() => null));
              }
            }
            if (!resolved) return yield* new Unauthorized();
            const resolvedOrganizationId =
              (resolved.session as any).activeOrganizationId ?? organizationId;
            return {
              kind: "member" as const,
              accountId: resolved.user.id,
              organizationId: resolvedOrganizationId,
              organizationName,
              organizationSlug,
              email: resolved.user.email,
              name: resolved.user.name ?? null,
              avatarUrl: resolved.user.image ?? null,
              roles: (((resolved.user as any).role ?? "user") as string)
                .split(",")
                .map((role) => role.trim())
                .filter((role) => role.length > 0),
            };
          }),
      });
    }),
  );
