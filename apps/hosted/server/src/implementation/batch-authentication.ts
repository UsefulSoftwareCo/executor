import { dashboardBatchPath, maxBatchReads } from "@executor-js/dashboard-start/batch";
import { Cache, Context, Data, Duration, Effect, Exit, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { SessionAuthentication, type Principal } from "../contracts/auth.ts";
import { OrganizationTombstones } from "../contracts/organization-removal.ts";
import type { OrganizationId } from "../contracts/organization.ts";

const BatchAuthentication = Context.Reference<typeof SessionAuthentication.Service | undefined>(
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

const answersOnly = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? Duration.infinity : Duration.zero;

export const requestAuthentication = (native: typeof SessionAuthentication.Service) =>
  Effect.map(BatchAuthentication, (batch) => batch ?? native);

export const requestTombstones = Effect.gen(function* () {
  return (yield* BatchTombstones) ?? (yield* OrganizationTombstones);
});

export const batchAuthentication = HttpRouter.middleware(
  Effect.gen(function* () {
    const native = yield* SessionAuthentication;
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
        const headers = new Headers(request.headers);
        const sessions = yield* Cache.makeWith(() => native.current(headers), {
          capacity: 1,
          timeToLive: answersOnly,
        });
        const organizations = yield* Cache.makeWith(native.organization, {
          capacity: maxBatchReads,
          timeToLive: answersOnly,
        });
        const memberships = yield* Cache.makeWith(
          ({ principal, organization }: Membership) => native.membership(principal, organization),
          { capacity: maxBatchReads, timeToLive: answersOnly },
        );
        const removed = yield* Cache.makeWith(tombstones, {
          capacity: maxBatchReads,
          timeToLive: answersOnly,
        });
        return yield* handler.pipe(
          Effect.provideService(BatchAuthentication, {
            ...native,
            current: () => Cache.get(sessions, undefined),
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
