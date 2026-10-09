/** App domain status for API callers; the AppDomainController Worker hosts the coordinator. */
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { AppUiAddressInvalid } from "@executor-js/hosted-server/app-ui/contracts";
import { OrganizationId, OrganizationSlug } from "@executor-js/hosted-server/organization";
import { UiFailed } from "apps/ui/contracts";
import { Clock, Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { timingSafeEqual } from "node:crypto";
import { AppDomainController } from "./app-domain-controller-worker.ts";
import { appDomainControlSecret } from "./app-domain-control.ts";
import { cloudAppUiBase } from "../contracts/app-ui.ts";
import { readAppDomainRecord } from "../implementation/app-domain-records.ts";

export const Team = Schema.Struct({ id: OrganizationId, slug: OrganizationSlug });

/** Team DNS could not be emptied; the controller logged the provider failure. */
export class AppDomainDrainFailed extends Schema.TaggedError<AppDomainDrainFailed>()(
  "AppDomainDrainFailed",
  {},
) {}

interface Coordinator {
  /** Reconcile soon: a team was created or renamed, or a visitor found no record. */
  readonly wake: () => Effect.Effect<void, never, RuntimeContext>;
  /** Restore a missing schedule without starting an extra pass. */
  readonly heartbeat: () => Effect.Effect<void, never, RuntimeContext>;
  /** Stop reconciliation and remove every team record before the stage is destroyed. */
  readonly drain: () => Effect.Effect<void, AppDomainDrainFailed, RuntimeContext>;
  readonly resume: () => Effect.Effect<void, never, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
}

/**
 * A single durable object serializes desired-state reconciliation for this deployed stage. The
 * namespace, with its Alchemy resource journal, moved here from the API Worker.
 */
export class AppDomainCoordinator extends Cloudflare.DurableObject<
  AppDomainCoordinator,
  Coordinator
>()("AppDomainCoordinator", { transferredFrom: "Api" }) {}

/** Three missed five-minute passes; a scheduled pass alone keeps a record newer than this. */
const staleAfter = 15 * 60_000;

/**
 * Team creation and renames wake provisioning through the durable provisioning outbox, and visitors
 * wake it on a missing record. The coordinator's own alarm runs a full pass every five minutes,
 * which also removes deleted teams; the five-minute background job's heartbeat only restores that
 * schedule if it was lost.
 */
export const cloudAppDomains = Effect.gen(function* () {
  const coordinator = yield* AppDomainCoordinator.from(AppDomainController);
  const base = yield* cloudAppUiBase.pipe(Effect.orDie);
  // Local development serves apps over HTTP and provisions no domains.
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
  /**
   * Reads the team's last observation from the database, beside the request's other queries.
   * Only a team without a current record calls the coordinator, which may start a fresh isolate.
   */
  const status = (team: typeof Team.Type) =>
    Effect.gen(function* () {
      if (suffix === undefined) return "ready" as const;
      if (`*.${team.slug}.${suffix}`.length > 64)
        return yield* new AppUiAddressInvalid({ reason: "too_long" });
      const record = yield* readAppDomainRecord(team.id);
      if (record === undefined || record.slug !== team.slug) {
        // Coalesce concurrent first visits into one pass before it reads the desired set.
        yield* wake;
        return "pending" as const;
      }
      // Issued certificates do not lapse because a pass was late, so a ready team keeps its link
      // while the lost schedule is restored.
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
      Effect.catchCause(() => Effect.logError("App domain heartbeat failed")),
    ),
  };
});
