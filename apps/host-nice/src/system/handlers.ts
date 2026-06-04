import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { SystemError, SystemHttpApi } from "./api";
import { BetterAuth, type BetterAuthHandle } from "../auth/better-auth";
import { HostNiceDb, type HostNiceDbHandle } from "../db/postgres-db";

// ---------------------------------------------------------------------------
// Handlers for the public system API. Unauthenticated; every DB touch is an
// Effect.tryPromise. `health` fails soft (a DB hiccup reports "degraded", it
// never throws); `setup-status` reports whether the one org has zero members.
// ---------------------------------------------------------------------------

export const SystemHandlers = HttpApiBuilder.group(SystemHttpApi, "system", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        const { sql } = yield* HostNiceDb;
        const status = yield* Effect.tryPromise({
          try: () => sql`select 1`,
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
        const { auth } = yield* BetterAuth;
        // Multi-org: a fresh instance with no users at all needs first-run setup
        // (create the first admin). Once any user exists, setup is done; new
        // orgs are created in-app via the organization plugin.
        const count = yield* Effect.tryPromise({
          try: () =>
            auth.$context.then(({ adapter }) => adapter.count({ model: "user", where: [] })),
          catch: () => new SystemError({ message: "failed to read setup status" }),
        });
        return { needsSetup: count === 0 };
      }),
    ),
);

export interface SelfHostSystemApiDeps {
  readonly betterAuth: BetterAuthHandle;
  readonly db: HostNiceDbHandle;
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
      Layer.mergeAll(Layer.succeed(BetterAuth)(betterAuth), Layer.succeed(HostNiceDb)(db)),
    ),
  );
};
