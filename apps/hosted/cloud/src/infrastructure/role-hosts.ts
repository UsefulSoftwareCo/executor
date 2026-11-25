import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { cloudRoleHosts, customDomain, hostRoles, testStage, type RoleHosts } from "./stage.ts";

export const deployedRoleHosts = Effect.gen(function* () {
  const roles = yield* cloudRoleHosts.pipe(Effect.orDie);
  if (Option.isNone(roles)) return Option.none<RoleHosts & { readonly zone: string }>();
  const zone = roles.value.zone;
  if (Option.isNone(zone))
    return yield* Effect.die(
      new Error(
        "EXECUTOR_ROLE_HOSTS_DOMAIN is for local runs; a deployed stage's role hosts come from its stage",
      ),
    );
  return Option.some({ ...roles.value, zone: zone.value });
});

export const roleHostRoutes = Effect.gen(function* () {
  const roles = yield* deployedRoleHosts;
  if (Option.isNone(roles)) return {};
  const { origins, authKit, zone } = roles.value;
  const routes = yield* Effect.forEach(
    [...hostRoles.map((role) => origins[role]), authKit],
    (origin) =>
      Effect.map(customDomain(new URL(origin)), (hostname) => ({
        pattern: `${hostname}/*`,
        zoneName: zone,
      })),
  );
  return { routes };
});

export const testStageEdge = Effect.gen(function* () {
  if (Option.isNone(yield* testStage.pipe(Effect.orDie))) return Option.none<string>();
  return Option.map(yield* cloudRoleHosts.pipe(Effect.orDie), (roles) => roles.edge);
});

export const testStageRoleHostRecords = Effect.gen(function* () {
  if (Option.isNone(yield* testStage.pipe(Effect.orDie))) return;
  const roles = yield* deployedRoleHosts;
  if (Option.isNone(roles)) return;
  const { origins, zone, edge, authKit } = roles.value;
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const found = yield* Cloudflare.Zone.findZoneByName({ accountId, name: zone }).pipe(Effect.orDie);
  if (!found) return yield* Effect.die(new Error(`Cloudflare zone ${zone} is missing`));
  const record = (id: string, origin: string, comment: string) =>
    Cloudflare.DNS.Record(id, {
      zoneId: found.id,
      zoneName: zone,
      name: new URL(origin).hostname,
      type: "AAAA",
      content: "100::",
      proxied: true,
      ttl: "1",
      comment,
    });
  for (const role of hostRoles)
    yield* record(
      `RoleHost-${role}`,
      origins[role],
      "Routes this test stage's role host to its API Worker",
    );
  yield* record("EdgeHost", edge, "Routes this test stage's edge to its forwarding Worker");
  yield* record(
    "AuthKitHost",
    authKit,
    "Routes this test stage's stand-in for v1's AuthKit host to its API Worker",
  );
});
