import { dashboardBatchPath, maxBatchReads } from "@executor-js/dashboard-start/batch";
import { Cache, Context, Data, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { Authentication, type Principal } from "../contracts/auth.ts";
import { OrganizationTombstones } from "../contracts/organization-removal.ts";
import type { OrganizationId } from "../contracts/organization.ts";

const BatchAuthentication = Context.Reference<typeof Authentication.Service | undefined>(
  "hosted/BatchAuthentication",
  { defaultValue: () => undefined },
);
const BatchTombstones = Context.Reference<typeof OrganizationTombstones.Service | undefined>(
  "hosted/BatchTombstones",
  { defaultValue: () => undefined },
);

class Membership extends Data.Class<{
  readonly principal: Principal;
  readonly organization: OrganizationId;
}> {}

/** A batch's reads all carry its one identity; other requests use the native checks. */
export const requestAuthentication = (native: typeof Authentication.Service) =>
  Effect.map(BatchAuthentication, (batch) => batch ?? native);

export const requestTombstones = Effect.gen(function* () {
  return (yield* BatchTombstones) ?? (yield* OrganizationTombstones);
});

/**
 * Share pending and completed identity reads only inside one dashboard batch. The router's
 * streaming response captures this context, so every read shares it until the batch ends.
 * Resource permissions still run in each endpoint, and the next request reads authority again.
 */
export const batchAuthentication = HttpRouter.middleware(
  Effect.gen(function* () {
    const native = yield* Authentication;
    const tombstones = yield* OrganizationTombstones;
    return (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (
          request.method !== "POST" ||
          Option.isNone(url) ||
          url.value.pathname !== dashboardBatchPath ||
          request.headers.authorization !== undefined
        )
          return yield* handler;
        const current = yield* Effect.cached(native.current(new Headers(request.headers)));
        const organizations = yield* Cache.make({
          capacity: maxBatchReads,
          lookup: native.organization,
        });
        const memberships = yield* Cache.make({
          capacity: maxBatchReads,
          lookup: ({ principal, organization }: Membership) =>
            native.membership(principal, organization),
        });
        const removed = yield* Cache.make({ capacity: maxBatchReads, lookup: tombstones });
        return yield* handler.pipe(
          Effect.provideService(BatchAuthentication, {
            ...native,
            current: () => current,
            organization: (reference) => Cache.get(organizations, reference),
            membership: (principal, organization) =>
              Cache.get(memberships, new Membership({ principal, organization })),
          }),
          Effect.provideService(BatchTombstones, (organization) =>
            Cache.get(removed, organization),
          ),
        );
      });
  }),
);
