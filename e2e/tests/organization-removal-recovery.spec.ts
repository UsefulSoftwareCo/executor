/**
 * A removal whose Workflow start stalls through its request's window is started by the recovery
 * object's alarm, not by cron: a new deployment's Cron Triggers can begin hours late. Local
 * Workflows never stalls by itself, so the local Worker's test hook stalls `create` for the
 * organizations this scenario names in `e2e_organization_removal_stall`; deployed Workers never
 * install it.
 *
 * A stall lasts until the scenario releases it, never for a fixed time: the scenario first sees
 * each request's window end and arm the alarm, and a recovery run fail on the stall. Then it holds
 * the next run before it reads the pending starts, adds the older tombstones, releases the stalls
 * and lets that run go, so one run reads everything with nothing stalled.
 *
 * The scenario runs between two of the local Worker's minute crons, so no cron job runs while a
 * start is pending, and it checks every start's trace for the alarm that ran it. 50 older
 * tombstones whose workflow already exists stand in for removals that started and are still
 * erasing; one run of the job must page past them. A row lock on the last one's start record holds
 * that run open while another removal arms the alarm, which must survive the run's success.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { Organization, type SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

/** More running tombstones than one page of the job, which reads 50. */
const olderTombstones = 50;
const Status = Schema.Array(Schema.Struct({ status: Schema.Literals(["running", "done"]) }));
const Instance = Schema.Tuple([Schema.Struct({ instance_id: Schema.String })]);
const Holder = Schema.Tuple([Schema.Struct({ pid: Schema.Number })]);

/** Every span of a trace, once `until` holds or `by` (epoch milliseconds) passes. */
const traceSpans = (traceId: string, until: (spans: ReadonlyArray<Span>) => boolean, by: number) =>
  Effect.flatMap(Telemetry, (telemetry) => telemetry.query(traceId)).pipe(
    Effect.map((found) => found.data.map(({ span }) => span)),
    Effect.filterOrFail(until, () => new Error(`The spans of trace ${traceId} have not arrived`)),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), while: () => Date.now() < by }),
  );

/** The span names from a span up to its trace's root. */
const ancestry = (spans: ReadonlyArray<Span>, span: Span) => {
  const byId = new Map(spans.map((entry) => [entry.spanId, entry]));
  const chain: Array<Span> = [];
  let current: Span | undefined = span;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = current.parentSpanId === null ? undefined : byId.get(current.parentSpanId);
  }
  return chain;
};

const isStart = (span: Span) => span.operationName === "organization.removal.start";
const isRecovery = (span: Span) => span.operationName === "organization.removal.recovery";
const isJob = (span: Span) => span.operationName === "job.organization-removal.dispatch";

layer(HostedLive, { excludeTestServices: true })("Organization removal recovery", (it) => {
  it.effect(
    scenarios.organizationRemovalRecovery.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors,
            api = yield* Api,
            target = yield* Target,
            telemetry = yield* Telemetry,
            evidence = yield* Evidence,
            locks = yield* cloudLocks;
          const suffix = randomUUID().slice(0, 8);
          const created: Array<string> = [];
          const removed = new Set<string>();
          // A synthetic organization ID sorts after every generated one, so the held tombstone is
          // the last row the run reads and the run reads no page after it.
          const older = Array.from(
            { length: olderTombstones },
            (_, index) => `zzzzzzzz-${suffix}-${String(index).padStart(2, "0")}`,
          );
          const held = older.at(-1)!;

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* locks.release;
              yield* locks.run({
                sql: "delete from e2e_organization_removal_stall where organization_id = any(string_to_array($1, ','))",
                params: [created.join(",")],
              });
              yield* locks.run({
                sql: "delete from cloud_organization_removal_start where organization_id = any(string_to_array($1, ','))",
                params: [older.join(",")],
              });
              yield* locks.run({
                sql: "delete from hosted_organization_removal where organization_id = any(string_to_array($1, ','))",
                params: [older.join(",")],
              });
              for (const organization of created.filter((id) => !removed.has(id)))
                yield* api
                  .request(actors.owner, "DELETE", `/api/organizations/${organization}`)
                  .pipe(Effect.ignore);
            }).pipe(Effect.ignore),
          );

          const status = (organization: string) =>
            locks
              .run({
                sql: "select status from hosted_organization_removal where organization_id = $1",
                params: [organization],
              })
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Status)),
                Effect.map((rows) => rows[0]?.status),
                Effect.orDie,
              );
          const finished = (organization: string, by: number) =>
            status(organization).pipe(
              Effect.filterOrFail(
                (state) => state === "done",
                () => new Error(`Removal of ${organization} has not finished`),
              ),
              Effect.retry({
                schedule: Schedule.spaced("500 millis"),
                while: () => Date.now() < by,
              }),
              Effect.tap(() => Effect.sync(() => removed.add(organization))),
            );
          /** A DELETE under a trace this scenario names, so its spans can be read afterwards. */
          const remove = (organization: string) =>
            Effect.gen(function* () {
              const traceId = randomBytes(16).toString("hex");
              const response = yield* actors.owner.send(
                "DELETE",
                `/api/organizations/${organization}`,
                undefined,
                {
                  origin: targetHosts(target).browser,
                  traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                },
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              return traceId;
            });
          /** Stall this organization's Workflows creates until `releaseStalls`, then accept its removal. */
          const removeStalled = (organization: string) =>
            locks
              .run({
                sql: `insert into e2e_organization_removal_stall (organization_id, stalled_until)
                  values ($1, 'infinity')
                  on conflict (organization_id) do update set stalled_until = excluded.stalled_until`,
                params: [organization],
              })
              .pipe(Effect.andThen(remove(organization)));
          const releaseStalls = (organizations: ReadonlyArray<string>) =>
            locks.run({
              sql: "delete from e2e_organization_removal_stall where organization_id = any(string_to_array($1, ','))",
              params: [organizations.join(",")],
            });
          /** The recovery object's arm for one removal; the object's spans start their own trace. */
          const armed = (organization: string, by: number) =>
            telemetry
              .search("organization.removal.recovery.arm", {
                "executor.organization.id": organization,
              })
              .pipe(
                Effect.map((found) =>
                  found.data
                    .map(({ span }) => span)
                    .filter((span) => span.operationName === "organization.removal.recovery.arm"),
                ),
                Effect.filterOrFail(
                  (found) => found.length > 0,
                  () => new Error(`Removal of ${organization} has not armed recovery`),
                ),
                Effect.retry({
                  schedule: Schedule.spaced("500 millis"),
                  while: () => Date.now() < by,
                }),
              );
          /** Server statements matching `query` that wait on the held transaction. */
          const waiting = (holder: number, query: string) =>
            locks.run({
              sql: `select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
                and query ilike $2`,
              params: [holder, query],
            });

          const [donor, first, second, late] = yield* evidence.step(
            "Owner creates four throwaway organizations",
            Effect.forEach(
              ["donor", "first", "second", "late"],
              (role) =>
                api
                  .request(actors.owner, "POST", "/api/auth/organization/create", {
                    name: `Recovery ${role} ${suffix}`,
                    slug: `recovery-${role}-${suffix}`,
                    keepCurrentActiveOrganization: true,
                  })
                  .pipe(
                    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
                    Effect.flatMap((response) => body(Organization, response)),
                    Effect.map((organization) => organization.id),
                    Effect.tap((id) => Effect.sync(() => created.push(id))),
                  ),
              { concurrency: 4 },
            ),
          );
          if (
            donor === undefined ||
            first === undefined ||
            second === undefined ||
            late === undefined
          )
            return yield* Effect.die("Expected four organizations");

          const instance = yield* evidence.step(
            "A removal that starts in its request finishes and leaves its workflow instance",
            Effect.gen(function* () {
              yield* remove(donor);
              yield* finished(donor, Date.now() + 30_000);
              const [row] = yield* locks
                .run({
                  sql: "select instance_id from hosted_organization_removal where organization_id = $1",
                  params: [donor],
                })
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Instance)), Effect.orDie);
              return row.instance_id;
            }),
          );
          yield* locks.run({
            sql: `create table if not exists e2e_organization_removal_stall (
              organization_id text primary key,
              stalled_until timestamptz not null
            )`,
          });

          // The local Worker fires its minute cron at second 0, and its job would start what is
          // pending. Start just after one so the whole run ends before the next.
          const clock = new Date(yield* Clock.currentTimeMillis).getUTCSeconds();
          yield* Effect.sleep(`${clock >= 2 && clock <= 4 ? 0 : (62 - clock) % 60} seconds`);
          const window = yield* Clock.currentTimeMillis;

          const [holder] = yield* locks
            .hold({ sql: "select pg_backend_pid() as pid" })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
          yield* locks.hold({
            sql: `insert into cloud_organization_removal_start (organization_id, instance_id)
              values ($1, $2)`,
            params: [held, instance],
          });

          const stalled = yield* evidence.step(
            "Two removals are accepted while their Workflow starts stall",
            Effect.all([removeStalled(first), removeStalled(second)], { concurrency: 2 }),
          );
          yield* evidence.step(
            "Each request's window ends with its start pending and arms the recovery alarm",
            Effect.forEach([first, second], (id) => armed(id, Date.now() + 25_000), {
              discard: true,
            }),
          );
          yield* evidence.step(
            "A recovery run fails while the starts stay stalled, and the alarm tries again",
            telemetry.search("organization.removal.recovery", {}).pipe(
              Effect.map((found) =>
                found.data
                  .map(({ span }) => span)
                  .filter(
                    (span) =>
                      isRecovery(span) &&
                      span.status === "error" &&
                      Date.parse(span.startTime) >= window,
                  ),
              ),
              Effect.filterOrFail(
                (failed) => failed.length > 0,
                () => new Error("No recovery run has failed on the stall"),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            ),
          );
          // Hold the next run before it reads the pending starts. Only the job reads this table, the
          // alarm runs one job at a time and no cron fires in this window, so no other run can read
          // or start anything meanwhile. A run already past its read fails on the stall and ends.
          yield* locks.hold({ sql: "savepoint gate" });
          yield* locks.hold({
            sql: "lock table cloud_organization_removal_start in access exclusive mode",
          });
          yield* evidence.step(
            "The next recovery run waits before reading the pending starts",
            waiting(holder.pid, "select r.organization_id%").pipe(
              Effect.filterOrFail(
                (rows) => rows.length > 0,
                () => new Error("No recovery run is waiting to read the pending starts"),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
              Effect.orDie,
            ),
          );
          yield* evidence.step(
            `${olderTombstones} older tombstones whose workflow already exists`,
            locks.run({
              sql: `insert into hosted_organization_removal (organization_id, instance_id, started_at)
                select unnest(string_to_array($1, ',')), $2, now() - interval '1 hour'`,
              params: [older.join(","), instance],
            }),
          );
          yield* releaseStalls([first, second]);
          // Lets the run read; the row lock on the held tombstone's start record stays.
          yield* locks.hold({ sql: "rollback to savepoint gate" });
          yield* evidence.step(
            "The recovery alarm's run reaches the held tombstone after starting the others",
            waiting(holder.pid, "insert into cloud_organization_removal_start%").pipe(
              Effect.filterOrFail(
                (rows) => rows.length > 0,
                () => new Error("No recovery run is waiting on the held tombstone"),
              ),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
              Effect.orDie,
            ),
          );
          const lateTrace = yield* evidence.step(
            "A third stalled removal arms the alarm while that run is held",
            Effect.gen(function* () {
              const traceId = yield* removeStalled(late);
              yield* armed(late, Date.now() + 25_000);
              return traceId;
            }),
          );
          // Still held: the run has not finished, so the late removal armed during it.
          expect(
            yield* waiting(holder.pid, "insert into cloud_organization_removal_start%"),
          ).not.toEqual([]);
          yield* releaseStalls([late]);
          yield* locks.release;

          yield* evidence.step(
            "Every stalled removal finishes without a cron job",
            Effect.forEach([first, second, late], (id) => finished(id, Date.now() + 20_000), {
              discard: true,
            }),
          );

          // Each stalled removal's request tried, failed and armed recovery; a recovery run
          // started it. No cron job started any of them.
          // A request's last attempt ends with its window, interrupted rather than failed.
          const startsOf = (organization: string, requestTrace: string) =>
            telemetry
              .search("organization.removal.start", { "executor.organization.id": organization })
              .pipe(
                Effect.map((found) => found.data.filter(({ span }) => isStart(span))),
                Effect.filterOrFail(
                  (found) =>
                    found.some(
                      ({ traceId, span }) => traceId !== requestTrace && span.status === "ok",
                    ),
                  () => new Error(`No successful start of ${organization} has arrived`),
                ),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
              );
          const runs = new Map<string, Span>();
          for (const [organization, requestTrace] of [
            [first, stalled[0]],
            [second, stalled[1]],
            [late, lateTrace],
          ] as const) {
            // The provider stalled the request's attempts, and the start was still pending when
            // its window ended: only then does a request arm recovery.
            yield* traceSpans(
              requestTrace,
              (spans) => spans.some((span) => isStart(span) && span.status === "error"),
              Date.now() + 10_000,
            );
            yield* armed(organization, Date.now() + 10_000);
            const starts = yield* startsOf(organization, requestTrace);
            for (const { traceId, span } of starts) {
              if (traceId === requestTrace) continue;
              const trace = yield* traceSpans(
                traceId,
                (spans) => spans.some(isRecovery),
                Date.now() + 10_000,
              ).pipe(Effect.orElseSucceed((): ReadonlyArray<Span> => []));
              const chain = ancestry(trace, span);
              yield* evidence.json(`start-${organization}-${span.spanId}.json`, {
                traceId,
                chain: chain.map((entry) => ({ name: entry.operationName, tags: entry.tags })),
              });
              const recovery = chain.find(isRecovery);
              expect(recovery, "Only the recovery alarm starts a stalled removal").toBeDefined();
              if (span.status === "ok" && recovery !== undefined) runs.set(organization, recovery);
            }
          }

          const run = runs.get(first)!;
          const later = runs.get(late)!;
          expect(runs.get(second)?.spanId, "One run started both").toBe(run.spanId);
          const runTrace = yield* telemetry.query(
            (yield* startsOf(first, stalled[0])).find(
              ({ traceId, span }) => traceId !== stalled[0] && span.status === "ok",
            )!.traceId,
          );
          const job = runTrace.data.map(({ span }) => span).find(isJob)!;
          yield* evidence.json("held-run.json", { recovery: run, job });
          expect(Number(job.tags["executor.removal.starts.checked"])).toBeGreaterThan(
            olderTombstones,
          );
          expect(job.tags["executor.removal.starts.pending"]).toBe("0");
          expect(job.status).toBe("ok");
          expect(run.status).toBe("ok");
          expect(
            Date.parse(later.startTime),
            "The late removal is started by a run after the held one",
          ).toBeGreaterThan(Date.parse(run.startTime));

          yield* evidence.step(
            "The alarm stops once nothing is pending",
            Effect.gen(function* () {
              yield* Effect.sleep("8 seconds");
              const recoveries = (yield* telemetry.search("organization.removal.recovery", {})).data
                .map(({ span }) => span)
                .filter(isRecovery)
                .filter((span) => Date.parse(span.startTime) >= window);
              yield* evidence.json(
                "recovery-runs.json",
                recoveries.map((span) => ({
                  start: span.startTime,
                  status: span.status,
                  attempt: span.tags["executor.removal.recovery.attempt"],
                })),
              );
              const last = recoveries.reduce((latest, span) =>
                Date.parse(span.startTime) > Date.parse(latest.startTime) ? span : latest,
              );
              expect(last.spanId, "No run follows the one that started the late removal").toBe(
                later.spanId,
              );
              expect(last.status).toBe("ok");
            }),
          );
          const elapsed = (yield* Clock.currentTimeMillis) - window;
          yield* evidence.json("window.json", {
            second: new Date(window).getUTCSeconds(),
            elapsed,
          });
          expect(elapsed, "The run ended before the next minute cron").toBeLessThan(56_000);
        }),
      ),
    // Up to a minute waits for a cron-free window; the window itself takes about 40 seconds.
    { timeout: 240_000 },
  );
});
