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
  readonly domain?: { readonly hostname: string; readonly v1Worker: string } | undefined;
  readonly moveDomain: boolean;
  readonly gateway: string;
  readonly serveByGateway: boolean;
  readonly onDelete: "v1" | "remove";
}

export type ExecutorShHostname = Resource<
  "Executor.ExecutorShHostname",
  HostnameProps,
  { readonly gateway: string; readonly domainMoved: boolean }
>;
export const ExecutorShHostname = Resource<ExecutorShHostname>("Executor.ExecutorShHostname");

const routeTo = (zoneId: string, pattern: string, script: string) =>
  Effect.gen(function* () {
    const routes = (yield* workers.listRoutes({ zoneId })).result;
    const found = routes.find((route) => route.pattern === pattern);
    if (found?.script === script) return;
    if (found === undefined) yield* workers.createRoute({ zoneId, pattern, script });
    else yield* workers.updateRoute({ zoneId, routeId: found.id, pattern, script });
  });

const removeRoute = (zoneId: string, pattern: string) =>
  Effect.gen(function* () {
    const routes = (yield* workers.listRoutes({ zoneId })).result;
    for (const route of routes)
      if (route.pattern === pattern) yield* workers.deleteRoute({ zoneId, routeId: route.id });
  });

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

export const executorShHostname = (workersOf: {
  readonly gateway: Output.Output<string>;
  readonly edge: Output.Output<string> | undefined;
}) =>
  Effect.gen(function* () {
    const owner = yield* executorShSetting.pipe(Effect.orDie);
    const production = Option.getOrUndefined(yield* stageName) === productionStage;
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
