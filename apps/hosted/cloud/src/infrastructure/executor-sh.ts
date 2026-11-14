/**
 * Who serves `executor.sh`: v1's Workers, or v2's gateway (`notes/v1-shutdown.md`, "The switch").
 * v1 claims the hostname twice: its edge Worker (`executor-cloud-edge`) holds the zone route
 * `executor.sh/*`, which runs first, and its app Worker (`executor-cloud`) holds the Workers Custom
 * Domain `executor.sh`, the origin behind that route, which also owns the hostname's DNS record.
 * `CLOUD_EXECUTOR_SH` decides, on production only:
 *
 * - `v1` (the default): this stack declares nothing, and v1's Workers keep both.
 * - `route`: the route is moved to the gateway (one update of the route, no gap). Every request
 *   reaches the gateway; the custom domain stays v1's, as an origin nothing reaches.
 * - `v2`: the custom domain moves too, detached from v1's Worker and attached to the gateway.
 *   Cloudflare will not reassign a hostname another Worker holds, so for a few seconds the
 *   hostname has no managed DNS record. Do it once `route` has held.
 *
 * Going back hands what moved back to v1's Workers: the resource's delete (`v1`) or its update
 * (`v2` to `route`). A test stage plays the same switch with its own edge host and its
 * v1-playing edge Worker, without a custom domain: there the resource always owns the route and
 * points it at the edge Worker (`v1`) or the gateway, and removes it with the stage.
 */
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { executorShSetting } from "./executor-sh-setting.ts";
import { deployedRoleHosts, testStageEdge } from "./role-hosts.ts";
import { productionStage, stageName, testStage } from "./stage.ts";

/** Production's names: the zone, v1's two Workers and v2's gateway. */
export const productionExecutorSh = {
  zone: "executor.sh",
  route: { pattern: "executor.sh/*", v1Worker: "executor-cloud-edge" },
  domain: { hostname: "executor.sh", v1Worker: "executor-cloud" },
  gateway: "executor-next-marketing-v2",
} as const;

interface HostnameProps {
  readonly accountId: string;
  readonly zoneId: string;
  readonly route: { readonly pattern: string; readonly v1Worker: string };
  /** The custom domain, which moves only when `moveDomain` is set. */
  readonly domain?: { readonly hostname: string; readonly v1Worker: string } | undefined;
  readonly moveDomain: boolean;
  readonly gateway: string;
  /** Whether the route points at the gateway now, or at the v1 Worker (a test stage switched off). */
  readonly serveByGateway: boolean;
  /**
   * What deleting the resource does with the route: give it back to v1's Worker (production), or
   * remove it with the stage that owns it (a test stage, whose edge Worker goes too).
   */
  readonly onDelete: "v1" | "remove";
}

/** The hostname served by v2's gateway; deleting it hands the hostname back to v1. */
export type ExecutorShHostname = Resource<
  "Executor.ExecutorShHostname",
  HostnameProps,
  { readonly gateway: string; readonly domainMoved: boolean }
>;
export const ExecutorShHostname = Resource<ExecutorShHostname>("Executor.ExecutorShHostname");

/** Point the zone route at `script`, creating it if it does not exist. */
const routeTo = (zoneId: string, pattern: string, script: string) =>
  Effect.gen(function* () {
    const routes = (yield* workers.listRoutes({ zoneId })).result;
    const found = routes.find((route) => route.pattern === pattern);
    if (found?.script === script) return;
    if (found === undefined) yield* workers.createRoute({ zoneId, pattern, script });
    else yield* workers.updateRoute({ zoneId, routeId: found.id, pattern, script });
  });

/** Delete the zone route, if it exists. */
const removeRoute = (zoneId: string, pattern: string) =>
  Effect.gen(function* () {
    const routes = (yield* workers.listRoutes({ zoneId })).result;
    for (const route of routes)
      if (route.pattern === pattern) yield* workers.deleteRoute({ zoneId, routeId: route.id });
  });

/** Attach the custom domain to `service`, detaching it from any other Worker first. */
const domainTo = (accountId: string, zoneId: string, hostname: string, service: string) =>
  Effect.gen(function* () {
    const attached = (yield* workers.listDomains({ accountId, hostname })).result.filter(
      (domain) => domain.hostname === hostname,
    );
    if (attached.some((domain) => domain.service === service)) return;
    for (const domain of attached)
      if (domain.id !== undefined && domain.id !== null)
        yield* workers.deleteDomain({ accountId, domainId: domain.id });
    yield* workers.putDomain({ accountId, hostname, service, zoneId });
  });

/** The Cloudflare API with the deploy's own token. */
const cloudflare = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            Credentials,
            Effect.succeed(apiTokenCredentials({ apiToken: Redacted.value(token) })),
          ),
          FetchHttpClient.layer,
        ),
      ),
    );
  }).pipe(Effect.orDie);

/**
 * Create and update move the route, and with `moveDomain` the custom domain, to the gateway; an
 * update without `moveDomain` gives a moved domain back. Delete gives both back to v1's Workers.
 * Each step is idempotent, so an interrupted switch is finished by running it again.
 */
export const ExecutorShHostnameProvider = () =>
  Provider.succeed(ExecutorShHostname, {
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      cloudflare(
        Effect.gen(function* () {
          yield* routeTo(
            news.zoneId,
            news.route.pattern,
            news.serveByGateway ? news.gateway : news.route.v1Worker,
          );
          if (news.domain !== undefined)
            yield* domainTo(
              news.accountId,
              news.zoneId,
              news.domain.hostname,
              news.moveDomain ? news.gateway : news.domain.v1Worker,
            );
          return {
            gateway: news.gateway,
            domainMoved: news.domain !== undefined && news.moveDomain,
          };
        }),
      ),
    delete: ({ olds }) =>
      cloudflare(
        Effect.gen(function* () {
          if (olds.onDelete === "remove") {
            yield* removeRoute(olds.zoneId, olds.route.pattern);
            return;
          }
          // The route first: it decides who serves the hostname, and moves with no gap.
          yield* routeTo(olds.zoneId, olds.route.pattern, olds.route.v1Worker);
          if (olds.domain !== undefined)
            yield* domainTo(
              olds.accountId,
              olds.zoneId,
              olds.domain.hostname,
              olds.domain.v1Worker,
            );
        }),
      ),
  });

/**
 * Declare the switch for this stage when `CLOUD_EXECUTOR_SH` is not `v1`: production's hostname,
 * or a test stage's edge host, which its v1-playing edge Worker holds otherwise. Any other stage
 * refuses the setting. `gateway` and `edge` are the deployed Workers' names; the resource is
 * created after the gateway exists.
 */
export const executorShHostname = (workersOf: {
  readonly gateway: Output.Output<string>;
  readonly edge: Output.Output<string> | undefined;
}) =>
  Effect.gen(function* () {
    const owner = yield* executorShSetting.pipe(Effect.orDie);
    const production = Option.getOrUndefined(yield* stageName) === productionStage;
    // Production declares nothing until it is switched; a test stage's switch always owns its
    // edge route, so its v1-playing edge Worker never declares one.
    if (owner === "v1" && (production || workersOf.edge === undefined)) return;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const zoneId = (zone: string) =>
      Cloudflare.Zone.findZoneByName({ accountId, name: zone }).pipe(
        Effect.orDie,
        Effect.flatMap((found) =>
          found
            ? Effect.succeed(found.id)
            : Effect.die(new Error(`Cloudflare zone ${zone} is missing`)),
        ),
      );
    if (production) {
      yield* ExecutorShHostname("ExecutorSh", {
        accountId,
        zoneId: yield* zoneId(productionExecutorSh.zone),
        route: productionExecutorSh.route,
        domain: productionExecutorSh.domain,
        moveDomain: owner === "v2",
        serveByGateway: true,
        onDelete: "v1",
        // Pinned in production (`marketing.ts`); the Worker's output orders the switch after it.
        gateway: workersOf.gateway.pipe(Output.map(() => productionExecutorSh.gateway)),
      });
      return;
    }
    const edge = yield* testStageEdge;
    const roles = yield* deployedRoleHosts;
    if (
      Option.isNone(yield* testStage.pipe(Effect.orDie)) ||
      Option.isNone(edge) ||
      Option.isNone(roles) ||
      workersOf.edge === undefined
    )
      return yield* Effect.die(
        new Error("CLOUD_EXECUTOR_SH applies to production and to test stages with an edge"),
      );
    yield* ExecutorShHostname("ExecutorSh", {
      accountId,
      zoneId: yield* zoneId(roles.value.zone),
      route: { pattern: `${new URL(edge.value).hostname}/*`, v1Worker: workersOf.edge },
      moveDomain: false,
      gateway: workersOf.gateway,
      serveByGateway: owner !== "v1",
      onDelete: "remove",
    });
  });
