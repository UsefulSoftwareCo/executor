/**
 * How the role hosts (`app.`, `mcp.`, `api.`; see `stage.ts`) reach the API Worker. They are zone
 * routes on proxied `100::` records rather than Workers Custom Domains: a custom domain orders an
 * Advanced certificate that Cloudflare may then serve for the zone apex (`product-zone.ts`), and
 * a route orders none. The zone's existing certificates cover the hosts: `*.executor.sh` in
 * production, and on a test stage the stage's own custom-domain certificate, which covers
 * `*.<slug>.<test domain>`.
 *
 * Production's records are declared in `alchemy.dns.ts` with the rest of the product zone. A test
 * stage creates its own here, so they go when the stage is destroyed.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { cloudRoleHosts, customDomain, hostRoles, testStage, type RoleHosts } from "./stage.ts";

/** The role hosts of a deployed stage, with the zone that serves them. */
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

/**
 * The API Worker's `routes` prop: one zone route per role host and one for v1's AuthKit host, or
 * nothing without them.
 *
 * Production's AuthKit host, `signin.executor.sh`, is a DNS-only record naming WorkOS, so its
 * route sees no request until that record is proxied: the switch is turning proxying on in
 * Cloudflare, and turning it off gives the host back to WorkOS (`notes/v1-shutdown.md`,
 * "AuthKit"). A test stage's is proxied from the start (`testStageRoleHostRecords`).
 */
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

/**
 * A test stage's edge: the host its forwarding Worker serves in place of v1's edge on
 * `executor.sh`. Production's edge is v1's, so it has none here.
 */
export const testStageEdge = Effect.gen(function* () {
  if (Option.isNone(yield* testStage.pipe(Effect.orDie))) return Option.none<string>();
  return Option.map(yield* cloudRoleHosts.pipe(Effect.orDie), (roles) => roles.edge);
});

/**
 * A test stage's proxied records for its role hosts, edge and AuthKit host; production's are in
 * `alchemy.dns.ts`.
 */
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
