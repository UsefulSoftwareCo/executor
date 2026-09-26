/**
 * Seat counts for billing. Accepted memberships are seats; pending invitations
 * are not. `cloud_billing_seats.synced_count` is the count Autumn last
 * confirmed, so an unchanged count needs no provider call.
 */
import { OrganizationId } from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const Seats = Schema.Array(
  Schema.Struct({ count: Schema.NumberFromString, synced: Schema.NullOr(Schema.Number) }),
);
const Live = Schema.Array(Schema.Struct({ count: Schema.NumberFromString }));

/** The live member count and the last count confirmed in Autumn. Undefined when the organization is gone. */
export const seatCounts = (organization: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`select (select count(*) from member m where m."organizationId" = o.id)::text as count,
          s.synced_count as synced
        from organization o left join cloud_billing_seats s on s.organization_id = o.id
        where o.id = ${organization}`;
    return (yield* Schema.decodeUnknownEffect(Seats)(rows))[0];
  });

/**
 * Record the count Autumn now holds and whether the plan bills seats. Returns
 * the live count, read in the same statement, so a racing membership change is
 * seen; undefined when the organization is gone.
 */
export const recordSeats = (organization: OrganizationId, count: number, seatPlan: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`insert into cloud_billing_seats (organization_id, synced_count, seat_plan, checked_at)
        select id, ${count}, ${seatPlan}, now() from organization where id = ${organization}
      on conflict (organization_id) do update set synced_count = excluded.synced_count,
        seat_plan = excluded.seat_plan, checked_at = excluded.checked_at
      returning (select count(*) from member m where m."organizationId" = ${organization})::text as count`;
    return (yield* Schema.decodeUnknownEffect(Live)(rows))[0]?.count;
  });

/** A plan read outside a seat sync decides whether the daily reconcile checks this organization. */
export const recordSeatPlan = (organization: OrganizationId, seatPlan: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`insert into cloud_billing_seats (organization_id, seat_plan)
        select id, ${seatPlan} from organization where id = ${organization}
      on conflict (organization_id) do update set seat_plan = excluded.seat_plan`;
  });

/**
 * Seat-billed organizations, organizations never confirmed in Autumn, and any
 * whose confirmed count differs from the live count. Free organizations with an
 * unchanged count cost no provider call.
 */
export const seatReconcileCandidates = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`select o.id as organization from organization o
      left join cloud_billing_seats s on s.organization_id = o.id
      where s.organization_id is null or s.seat_plan
        or s.synced_count is distinct from (select count(*) from member m where m."organizationId" = o.id)`;
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ organization: OrganizationId })),
  )(rows);
});
