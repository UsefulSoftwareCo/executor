/**
 * One-off seed of the role hosts' connection resources (`notes/cloud-domains.md`). Since the role
 * hosts were added, a new scoped connection gets its OAuth resources at every MCP origin; a
 * connection created before has them only at the deployment origin, so a client cannot authorize
 * its URL on `mcp.`. This inserts the missing ones through the same insert-only seed a new
 * connection uses.
 *
 * It only inserts `oauthResource` rows: existing rows, connections and grants are never changed,
 * and re-running it inserts nothing new. Revoked connections and connections of a deleted
 * organization, or of one being removed, are skipped. `report` writes nothing.
 */
import { PgClient } from "@effect/sql-pg";
import {
  ConnectionId,
  mcpOAuthResources,
  provisionHostedConnectionResources,
} from "@executor-js/hosted-server";
import { Effect, Option, Schema } from "effect";
import { cloudAuthSetup } from "./auth-provisioning.ts";
import { cloudRoleHosts } from "../infrastructure/stage.ts";

/** The deployment has no role hosts, so there is nothing to seed. */
export class RoleHostSeedRefused extends Schema.TaggedError<RoleHostSeedRefused>()(
  "RoleHostSeedRefused",
  { reason: Schema.String },
) {
  get message() {
    return this.reason;
  }
}

/** A read or insert failed; rows inserted before it stay, and a re-run continues. */
export class RoleHostSeedFailed extends Schema.TaggedError<RoleHostSeedFailed>()(
  "RoleHostSeedFailed",
  { operation: Schema.String },
) {
  get message() {
    return `Role host resource seed failed: ${this.operation}`;
  }
}

/** `report` counts what is missing; `apply` inserts it. */
export const SeedMode = Schema.Literals(["report", "apply"]);
export type SeedMode = typeof SeedMode.Type;

const ConnectionRow = Schema.Struct({
  id: ConnectionId,
  revoked: Schema.Boolean,
  removed: Schema.Boolean,
});

/** Counts per connection outcome, and the resource rows inserted or, in `report`, missing. */
export interface SeedSummary {
  readonly mode: SeedMode;
  readonly mcpOrigins: ReadonlyArray<string>;
  readonly connections: Readonly<Record<string, number>>;
  readonly resources: number;
}

/**
 * Seed every live connection's missing resources at the deployment's MCP origins. Fails with
 * {@link RoleHostSeedRefused} when the deployment has no role hosts and {@link RoleHostSeedFailed}
 * when a database step fails. Prints nothing; the caller reports the summary.
 */
export const seedRoleHostResources = (mode: SeedMode) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Without role hosts every resource is at the deployment origin already. Running it then
      // would hide that the settings do not name the deployment.
      const roles = yield* cloudRoleHosts.pipe(
        Effect.mapError(
          () => new RoleHostSeedRefused({ reason: "Invalid deployment or role host settings" }),
        ),
      );
      if (Option.isNone(roles))
        return yield* new RoleHostSeedRefused({
          reason:
            "This deployment has no role hosts; run it with the deployment's ALCHEMY_STAGE or EXECUTOR_ROLE_HOSTS_DOMAIN",
        });
      const failed = (operation: string) => () => new RoleHostSeedFailed({ operation });
      const setup = yield* cloudAuthSetup.pipe(Effect.mapError(failed("auth settings")));
      const mcpOrigins = setup.origins.resourceOrigins.mcp;
      const context = yield* setup.context.pipe(Effect.mapError(failed("auth context")));
      return yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql`select c.id, c.revoked,
          (o.id is null or exists (
            select 1 from hosted_organization_removal r where r.organization_id = c.resource
          )) as removed
        from "mcpConnection" c left join organization o on o.id = c.resource
        order by c.id`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConnectionRow))),
          Effect.mapError(failed("list connections")),
        );
        const connections: Record<string, number> = {};
        const count = (outcome: string) => (connections[outcome] = (connections[outcome] ?? 0) + 1);
        let resources = 0;
        for (const row of rows) {
          if (row.revoked) {
            count("revoked");
            continue;
          }
          if (row.removed) {
            count("organization removed");
            continue;
          }
          const identifiers = mcpOAuthResources(mcpOrigins, row.id).map((r) => r.identifier);
          const existing = yield* sql<{ identifier: string }>`select identifier from "oauthResource"
          where ${sql.in("identifier", identifiers)}`.pipe(
            Effect.mapError(failed("read resources")),
          );
          const missing = identifiers.length - new Set(existing.map((r) => r.identifier)).size;
          if (missing === 0) {
            count("present");
            continue;
          }
          resources += missing;
          if (mode === "report") {
            count("missing");
            continue;
          }
          yield* provisionHostedConnectionResources(setup.origins, context, row.id).pipe(
            Effect.mapError(failed("insert resources")),
          );
          count("seeded");
        }
        return { mode, mcpOrigins, connections, resources } satisfies SeedSummary;
      }).pipe(
        Effect.provide(PgClient.layer({ url: setup.url, maxConnections: 1 })),
        Effect.catchTag("SqlError", () =>
          Effect.fail(new RoleHostSeedFailed({ operation: "database" })),
        ),
      );
    }),
  );
