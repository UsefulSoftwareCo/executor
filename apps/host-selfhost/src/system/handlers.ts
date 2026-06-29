import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { SystemError, SystemHttpApi } from "./api";
import { BetterAuth, countOrgMembers, type BetterAuthHandle } from "../auth/better-auth";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";

// ---------------------------------------------------------------------------
// Handlers for the public system API. Unauthenticated; every DB touch is an
// Effect.tryPromise. `health` fails soft (a DB hiccup reports "degraded", it
// never throws); `setup-status` reports whether the one org has zero members.
// ---------------------------------------------------------------------------

export const SystemHandlers = HttpApiBuilder.group(SystemHttpApi, "system", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        const { client } = yield* SelfHostDb;
        const status = yield* Effect.tryPromise({
          try: () => client.execute("SELECT 1"),
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
        // Count via Better Auth's adapter (see countOrgMembers) so this read is
        // consistent with how memberships are written.
        const count = yield* Effect.tryPromise({
          try: () => countOrgMembers(auth, organizationId),
          catch: () => new SystemError({ message: "failed to read setup status" }),
        });
        return { needsSetup: count === 0 };
      }),
    ),
);

export interface SelfHostSystemApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly db: SelfHostDbHandle;
  readonly mountPrefix: `/${string}`;
}

/** Mountable extension route layer (see makeSelfHostAdminApiLayer). */
export const makeSelfHostSystemApiLayer = ({
  betterAuth,
  db,
  mountPrefix,
}: SelfHostSystemApiDeps) => {
  const prefixedRouter = Layer.effect(HttpRouter.HttpRouter)(
    Effect.map(HttpRouter.HttpRouter.asEffect(), (router) => router.prefixed(mountPrefix)),
  );
  return HttpApiBuilder.layer(SystemHttpApi).pipe(
    Layer.provide(SystemHandlers),
    Layer.provide(prefixedRouter),
    HttpRouter.provideRequest(
      Layer.mergeAll(Layer.succeed(BetterAuth)(betterAuth), Layer.succeed(SelfHostDb)(db)),
    ),
  );
};
