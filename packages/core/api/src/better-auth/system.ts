import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { SystemError, SystemHttpApi } from "./system-api";
import { BetterAuth, type BetterAuthHandle } from "./identity";
import { countOrgMembers } from "./shared";
import { findRedeemableCode } from "./invites";

export const SystemHandlers = HttpApiBuilder.group(SystemHttpApi, "system", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        const { dbClient } = yield* BetterAuth;
        const status = yield* Effect.tryPromise({
          try: () => dbClient.execute("SELECT 1"),
          catch: () => new SystemError({ message: "database unreachable" }),
        }).pipe(
          Effect.as("ok"),
          Effect.orElseSucceed(() => "degraded"),
        );
        return { status };
      }),
    )
    .handle("setupStatus", () =>
      Effect.gen(function* () {
        const { auth, organizationId } = yield* BetterAuth;
        const count = yield* Effect.tryPromise({
          try: () => countOrgMembers(auth, organizationId),
          catch: () => new SystemError({ message: "failed to read setup status" }),
        });
        return { needsSetup: count === 0 };
      }),
    )
    .handle("inviteStatus", ({ params }) =>
      Effect.gen(function* () {
        const { dbClient } = yield* BetterAuth;
        const code = yield* Effect.tryPromise({
          try: () => findRedeemableCode(dbClient, params.code),
          catch: () => new SystemError({ message: "failed to read invite status" }),
        });
        return { valid: code !== null };
      }),
    ),
);

export interface BetterAuthSystemApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly mountPrefix: `/${string}`;
}

export const makeBetterAuthSystemApiLayer = ({
  betterAuth,
  mountPrefix,
}: BetterAuthSystemApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  return HttpApiBuilder.layer(SystemHttpApi).pipe(
    Layer.provide(SystemHandlers),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(Layer.succeed(BetterAuth)(betterAuth)),
  );
};
