import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import {
  appUiAddressScheme,
  AppUiAddressInvalid,
} from "@executor-js/hosted-server/app-ui/contracts";
import { OrganizationId, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { UiFailed } from "apps/ui/contracts";
import { Clock, Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { timingSafeEqual } from "node:crypto";
import { AppDomainController } from "./app-domain-controller-worker.ts";
import { appDomainControlSecret } from "./app-domain-control.ts";
import { cloudAppUiBase } from "../contracts/app-ui.ts";
import { jobCompleted, jobFailedWith } from "../contracts/job-outcome.ts";
import { readAppDomainRecord } from "../implementation/app-domain-records.ts";

export const Team = Schema.Struct({ id: OrganizationId, slug: OrganizationSlug });

export class AppDomainDrainFailed extends Schema.TaggedError<AppDomainDrainFailed>()(
  "AppDomainDrainFailed",
  {},
) {}

interface Coordinator {
  readonly wake: () => Effect.Effect<void, never, RuntimeContext>;
  readonly heartbeat: () => Effect.Effect<void, never, RuntimeContext>;
  readonly drain: () => Effect.Effect<void, AppDomainDrainFailed, RuntimeContext>;
  readonly resume: () => Effect.Effect<void, never, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

export class AppDomainCoordinator extends Cloudflare.DurableObject<
  AppDomainCoordinator,
  Coordinator
>()("AppDomainCoordinator", { transferredFrom: "Api" }) {}

const staleAfter = 15 * 60_000;

export const cloudAppDomains = Effect.gen(function* () {
  if ((yield* appUiAddressScheme.pipe(Effect.orDie)) === "opaque")
    return {
      status: (_team: typeof Team.Type) => Effect.succeed("ready" as const),
      control: (_operation: "resume" | "drain") =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      heartbeat: Effect.succeed(jobCompleted),
    };
  const coordinator = yield* AppDomainCoordinator.from(AppDomainController);
  const base = yield* cloudAppUiBase.pipe(Effect.orDie);
  const suffix =
    base === undefined || new URL(base).protocol !== "https:" ? undefined : new URL(base).hostname;
  const controlSecret = yield* (yield* appDomainControlSecret).text;
  const heartbeat = Effect.suspend(() => coordinator.getByName("domains").heartbeat()).pipe(
    Effect.provide(RuntimeContext.phantom),
    Effect.withSpan("app_domains.heartbeat.rpc"),
  );
  const wake = Effect.suspend(() => coordinator.getByName("domains").wake()).pipe(
    Effect.provide(RuntimeContext.phantom),
    Effect.withSpan("app_domains.wake.rpc"),
    Effect.catchCause(() => Effect.fail(new UiFailed({ reason: "unavailable" }))),
  );
  const status = (team: typeof Team.Type) =>
    Effect.gen(function* () {
      if (suffix === undefined) return "ready" as const;
      if (`*.${team.slug}.${suffix}`.length > 64)
        return yield* new AppUiAddressInvalid({ reason: "too_long" });
      const record = yield* readAppDomainRecord(team.id);
      if (record === undefined || record.slug !== team.slug) {
        yield* wake;
        return "pending" as const;
      }
      if (record.checked_at.getTime() + staleAfter < (yield* Clock.currentTimeMillis)) yield* wake;
      return record.status;
    }).pipe(Effect.withSpan("app_domains.status"));
  const control = (operation: "resume" | "drain") =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const expected = Buffer.from(`Bearer ${Redacted.value(yield* controlSecret)}`);
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return HttpServerResponse.empty({ status: 404 });
      yield* coordinator.getByName("domains")[operation]();
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))));
  return {
    status,
    control,
    heartbeat: heartbeat.pipe(
      Effect.as(jobCompleted),
      Effect.catchCause((cause) =>
        Effect.logError("App domain heartbeat failed").pipe(Effect.as(jobFailedWith(cause))),
      ),
    ),
  };
});
