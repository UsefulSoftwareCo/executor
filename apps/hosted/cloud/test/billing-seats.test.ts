import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import { OrganizationId } from "@executor-js/hosted-server";
import { migrateBillingSeats } from "../src/implementation/migrations.ts";
import {
  recordSeatPlan,
  recordSeats,
  seatCounts,
  seatReconcileCandidates,
} from "../src/implementation/billing-seats.ts";

const team = OrganizationId.make("synthetic-team");
const other = OrganizationId.make("synthetic-other");
/** The Better Auth columns these statements read, with synthetic rows only. */
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table organization (id text primary key)`;
  yield* sql`create table member (id text primary key, "organizationId" text not null references organization(id) on delete cascade)`;
  yield* sql`insert into organization (id) values (${team}), (${other})`;
  yield* migrateBillingSeats;
  const member = (id: string, organization = team) =>
    sql`insert into member (id, "organizationId") values (${id}, ${organization})`;
  return { sql, member };
});
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(pgliteLayer())));
test("seat sync skips confirmed counts and the reconcile checks only what can drift", () =>
  run(
    Effect.gen(function* () {
      const { sql, member } = yield* fixture;
      yield* member("owner");
      assert.deepEqual(yield* seatCounts(team), { count: 1, synced: null });
      // Every organization starts unconfirmed.
      assert.deepEqual((yield* seatReconcileCandidates).map((row) => row.organization).sort(), [
        other,
        team,
      ]);
      assert.equal(yield* recordSeats(team, 1, false), 1);
      assert.equal(yield* recordSeats(other, 0, false), 0);
      assert.deepEqual(yield* seatCounts(team), { count: 1, synced: 1 });
      assert.deepEqual(yield* seatReconcileCandidates, []);
      // A membership change is visible to the reconcile, and to the job's re-read.
      yield* member("second");
      assert.deepEqual(yield* seatReconcileCandidates, [{ organization: team }]);
      assert.equal(yield* recordSeats(team, 1, false), 2);
      assert.equal(yield* recordSeats(team, 2, false), 2);
      // A seat plan is always checked, even with an unchanged count.
      yield* recordSeatPlan(team, true);
      assert.deepEqual(yield* seatReconcileCandidates, [{ organization: team }]);
      assert.deepEqual(yield* seatCounts(team), { count: 2, synced: 2 });
      yield* sql`delete from organization where id = ${team}`;
      assert.deepEqual(
        yield* sql`select * from cloud_billing_seats where organization_id = ${team}`,
        [],
      );
    }),
  ));
