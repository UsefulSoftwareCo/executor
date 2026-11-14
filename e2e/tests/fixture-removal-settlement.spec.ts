/**
 * The Cloud fixture's two halves of an organization's clean-up. A scenario's own clean-up
 * (`/remove`) returns as soon as the product has accepted the removal and refuses the
 * organization's owner; the erasure runs afterwards in the removal Workflow. The end-of-run check
 * (`settleRemovals`, `/settle`) is what waits for that erasure, once per run.
 *
 * The extra scenario's organization has its Workflow start stalled by the local Worker's test hook
 * (`organization-removal-stalls.ts`), so its erasure cannot begin. Its clean-up must still return,
 * leaving the organization row in place. The check, narrowed to that scenario with a short
 * deadline, must fail naming the scenario, the phase it is stuck in and since when, and note the
 * stall for the deployed runner's evidence. Once the stall is released the recovery alarm starts
 * the removal, and the check with its own deadline must find the organization row gone, the
 * removal done and the scenario's users deleted.
 *
 * Only this scenario's organization is stalled, and it is released before the case ends; the
 * check is narrowed to its scenario, so the run's own end-of-run check is not affected.
 */
import { expect, layer } from "@effect/vitest";
import { randomBytes } from "node:crypto";
import { createServer, request as forward } from "node:http";
import { Cause, Clock, Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarioLifetime } from "../support/lifecycle.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import {
  RemovalSettlement,
  removalSettlementFile,
  SettleLook,
  settleRemovals,
} from "../sdk/removal-settlement.ts";
import { fixtureRequest, FixtureControl } from "../sdk/fixtures.ts";
import { removalStallsFile, RemovalStall } from "../sdk/removal-evidence.ts";

const Status = Schema.Array(Schema.Struct({ status: Schema.Literals(["running", "done"]) }));
const Count = Schema.Tuple([Schema.Struct({ count: Schema.Number })]);
/** Accepted removals in the parallel case: four times the fixture's 6 checks at once. */
const many = 24;

layer(HostedLive, { excludeTestServices: true })("Fixture removal settlement", (it) => {
  it.effect(
    scenarios.fixtureRemovalSettlement.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            evidence = yield* Evidence,
            fs = yield* FileSystem.FileSystem;
          const [stalled] = scenarioLifetime(context).sdkScenarios;
          if (stalled === undefined)
            return yield* Effect.die(new Error("The test plan declares the stalled scenario"));
          const { scenario, scope } = stalled;
          const id = scenario.target.scenarioId;
          const fixtures = target.fixtures;
          if (scenario.actors === undefined || id === undefined || fixtures === undefined)
            return yield* Effect.die(new Error("A Cloud scenario has actors and a fixture"));
          const organization = scenario.actors.organization.id;
          const locks = yield* cloudLocks;
          const removal = locks
            .run({
              sql: "select status from hosted_organization_removal where organization_id = $1",
              params: [organization],
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Status)), Effect.orDie);
          const count = (sql: string, value: string) =>
            locks.run({ sql, params: [value] }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Count)),
              Effect.map(([row]) => row.count),
              Effect.orDie,
            );
          const organizations = count(
            "select count(*)::int as count from organization where id = $1",
            organization,
          );
          const users = count(
            `select count(*)::int as count from "user" where email like $1`,
            `agent-${id}-%@example.test`,
          );

          yield* locks.run({
            sql: `create table if not exists e2e_organization_removal_stall (
              organization_id text primary key,
              stalled_until timestamptz not null
            )`,
          });
          // Bounded, so a case that dies here cannot hold the removal for the rest of the run.
          yield* locks.run({
            sql: `insert into e2e_organization_removal_stall (organization_id, stalled_until)
              values ($1, now() + interval '3 minutes')`,
            params: [organization],
          });
          const release = locks.run({
            sql: "delete from e2e_organization_removal_stall where organization_id = $1",
            params: [organization],
          });
          yield* Effect.addFinalizer(() => Effect.ignore(release));
          expect(yield* users).toBe(3);

          const cleanUp = yield* evidence.step(
            "The scenario's clean-up returns while its removal cannot start",
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis;
              // The lifecycle's own clean-up: closing the scenario's scope sends its `/remove`,
              // which fails the case if the product does not accept or still answers the owner.
              yield* Scope.close(scope, Exit.void);
              return (yield* Clock.currentTimeMillis) - started;
            }),
          );
          yield* evidence.step(
            "The removal is accepted but the organization and its users remain",
            Effect.gen(function* () {
              expect(yield* removal).toEqual([{ status: "running" }]);
              expect(yield* organizations).toBe(1);
              expect(yield* users).toBe(3);
            }),
          );

          const files = {
            report: `${target.directory}/report/removal-settlement/${id}/${removalSettlementFile}`,
            stalls: `${target.directory}/${removalStallsFile}`,
          };
          const stuck = yield* evidence.step(
            "The end-of-run check names the stuck removal's scenario, phase and since when",
            settleRemovals(fixtures, files, { ids: [id], within: 5_000 }).pipe(Effect.flip),
          );
          expect(stuck._tag).toBe("RemovalsUnfinished");
          expect(stuck.message).toContain(
            `Organization removal for "Stalled removal organization" (scenario ${id}, organization ${organization}) has not finished: wait-for-organization since `,
          );
          const report = yield* fs
            .readFileString(files.report)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RemovalSettlement))),
            );
          yield* evidence.json("unfinished-removals.json", report);
          const unfinished = report.last;
          expect(unfinished?.finished).toEqual([]);
          expect(unfinished?.neverAccepted).toEqual([]);
          expect(unfinished?.unfinished).toHaveLength(1);
          const entry = unfinished?.unfinished[0];
          expect(entry).toMatchObject({
            scenario: id,
            label: "Stalled removal organization",
            organization,
            phase: "wait-for-organization",
            status: "running",
          });
          // Stuck in its first phase since the removal was accepted.
          expect(entry?.since).toBe(entry?.acceptedAt);
          // The deployed runner saves the Workflow instance and Worker logs for this line.
          const stalls = (yield* fs.readFileString(files.stalls))
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(RemovalStall))(line))
            .filter((line) => line.scenario === id);
          expect(stalls).toHaveLength(1);
          expect(stalls[0]).toMatchObject({
            organization,
            phase: "wait-for-organization",
            since: entry?.since,
            status: "running",
          });

          yield* release;
          const settled = yield* evidence.step(
            "Released, the removal finishes and the end-of-run check passes",
            settleRemovals(fixtures, files, { ids: [id] }),
          );
          yield* evidence.json("settled-removals.json", settled);
          expect(settled.last?.unfinished).toEqual([]);
          expect(settled.last?.finished).toHaveLength(1);
          expect(settled.last?.finished[0]).toMatchObject({ scenario: id, organization });
          expect(yield* organizations).toBe(0);
          expect(yield* removal).toEqual([{ status: "done" }]);
          expect(yield* users).toBe(0);
          yield* evidence.json("clean-up.json", { cleanUpMs: cleanUp });
        }),
      ),
    // The released start waits for the recovery alarm, at most 60 s apart, or the minute cron.
    { timeout: 150_000 },
  );

  it.effect(
    scenarios.fixtureRemovalSettlementMany.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            evidence = yield* Evidence;
          const fixtures = target.fixtures;
          if (fixtures === undefined)
            return yield* Effect.die(new Error("A Cloud scenario has a fixture"));
          const locks = yield* cloudLocks;
          // More removals than the fixture checks at once (6), with the first one blocked, so a
          // check that took them one at a time in order would finish none.
          const ids = Array.from({ length: many }, () => randomBytes(16).toString("hex"));
          const [blocked] = ids;
          if (blocked === undefined) return yield* Effect.die(new Error("No removals"));
          // Removed again if the case ends early, so the run's own check sees them accepted.
          yield* Effect.addFinalizer(() =>
            Effect.forEach(
              ids,
              (id) => Effect.ignore(fixtureRequest(fixtures, "/remove", { id })),
              {
                concurrency: 4,
                discard: true,
              },
            ),
          );
          yield* evidence.step(
            `${many} organizations are provisioned`,
            Effect.forEach(
              ids,
              (id, index) =>
                fixtureRequest(fixtures, "/actors", { id, label: `Many removals ${index}` }),
              { concurrency: 4, discard: true },
            ),
          );
          // The blocked removal's owner row stays locked against deletion; the product's own
          // erasure never deletes users, so it still finishes.
          const [owner] = yield* locks
            .hold({
              sql: `select id from "user" where email = $1 for no key update`,
              params: [`agent-${blocked}-owner@example.test`],
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))));
          expect(owner).toBeDefined();
          yield* evidence.step(
            "Each scenario's clean-up has its removal accepted",
            Effect.forEach(ids, (id) => fixtureRequest(fixtures, "/remove", { id }), {
              concurrency: 4,
              discard: true,
            }),
          );

          const looks: Array<{ ms: number; finished: number; checking: boolean }> = [];
          const others = yield* evidence.step(
            "Every look answers within its limit and the others finish while one is blocked",
            Effect.gen(function* () {
              while (true) {
                const asked = yield* Clock.currentTimeMillis;
                // A look that does not answer in 15 s fails the case: the request is never held.
                const look = yield* fixtureRequest(fixtures, "/settle", { ids }, "15 seconds").pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(SettleLook)),
                );
                const pending = look.unfinished.find((removal) => removal.scenario === blocked);
                looks.push({
                  ms: (yield* Clock.currentTimeMillis) - asked,
                  finished: look.finished.length,
                  checking: pending?.checking ?? false,
                });
                if (look.finished.length === many - 1) return look;
                yield* Effect.sleep("1 second");
              }
            }).pipe(Effect.timeout("90 seconds")),
          );
          yield* evidence.json("looks.json", looks);
          expect(others.finished.map((removal) => removal.scenario).sort()).toEqual(
            ids.slice(1).sort(),
          );
          expect(others.unfinished).toMatchObject([
            { scenario: blocked, phase: "remove-users", status: "done", checking: true },
          ]);

          yield* locks.release;
          const files = {
            report: `${target.directory}/report/removal-settlement/many/${removalSettlementFile}`,
            stalls: `${target.directory}/${removalStallsFile}`,
          };
          const settled = yield* evidence.step(
            "Once its users can be deleted the last removal finishes",
            settleRemovals(fixtures, files, { ids }),
          );
          expect(settled.last?.finished).toHaveLength(many);
          expect(settled.dropped).toBe(0);
          const users = yield* locks
            .run({
              sql: `select count(*)::int as count from "user" where email = any($1::text[])`,
              params: [
                `{${ids.flatMap((id) => ["owner", "admin", "member"].map((role) => `agent-${id}-${role}@example.test`)).join(",")}}`,
              ],
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Count)), Effect.orDie);
          expect(users[0].count).toBe(0);
        }),
      ),
    { timeout: 150_000 },
  );

  it.effect(
    scenarios.fixtureRemovalSettlementDropped.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            evidence = yield* Evidence;
          const fixtures = target.fixtures;
          if (fixtures === undefined)
            return yield* Effect.die(new Error("A Cloud scenario has a fixture"));
          const id = randomBytes(16).toString("hex");
          yield* Effect.addFinalizer(() =>
            Effect.ignore(fixtureRequest(fixtures, "/remove", { id })),
          );
          yield* fixtureRequest(fixtures, "/actors", { id, label: "Dropped look removal" });
          yield* fixtureRequest(fixtures, "/remove", { id });
          // A loopback proxy in front of the fixture that drops the first `/settle` request, as a
          // connection lost mid-request would, and passes every other request through unchanged.
          const upstream = new URL(fixtures.origin);
          let drops = 0;
          const proxy = yield* Effect.acquireRelease(
            Effect.callback<ReturnType<typeof createServer>>((resume) => {
              const server = createServer((incoming, outgoing) => {
                if (incoming.url === "/settle" && drops === 0) {
                  drops += 1;
                  incoming.socket.destroy();
                  return;
                }
                const sent = forward(
                  {
                    host: upstream.hostname,
                    port: upstream.port,
                    path: incoming.url,
                    method: incoming.method,
                    headers: incoming.headers,
                  },
                  (answer) => {
                    outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
                    answer.pipe(outgoing);
                  },
                );
                sent.on("error", () => outgoing.destroy());
                incoming.pipe(sent);
              });
              server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
            }),
            (server) =>
              Effect.callback<void>((resume) => {
                server.close(() => resume(Effect.void));
              }),
          );
          const address = proxy.address();
          if (address === null || typeof address === "string")
            return yield* Effect.die(new Error("The proxy listens on TCP"));
          const proxied = FixtureControl.make({
            origin: `http://127.0.0.1:${address.port}`,
            token: fixtures.token,
          });
          const settled = yield* evidence.step(
            "A dropped look is asked again and only an answer finishes the removal",
            settleRemovals(
              proxied,
              {
                report: `${target.directory}/report/removal-settlement/dropped-${id}/${removalSettlementFile}`,
                stalls: `${target.directory}/${removalStallsFile}`,
              },
              { ids: [id] },
            ),
          );
          yield* evidence.json("dropped-look.json", settled);
          expect(drops).toBe(1);
          expect(settled.dropped).toBe(1);
          expect(settled.requests).toBeGreaterThanOrEqual(2);
          expect(settled.last?.finished.map((removal) => removal.scenario)).toEqual([id]);
        }),
      ),
    { timeout: 120_000 },
  );

  it.effect(
    scenarios.fixtureRemovalSettlementDone.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            evidence = yield* Evidence;
          const [stalled] = scenarioLifetime(context).sdkScenarios;
          if (stalled === undefined)
            return yield* Effect.die(new Error("The test plan declares the stalled scenario"));
          const { scenario, scope } = stalled;
          const id = scenario.target.scenarioId;
          const fixtures = target.fixtures;
          if (scenario.actors === undefined || id === undefined || fixtures === undefined)
            return yield* Effect.die(new Error("A Cloud scenario has actors and a fixture"));
          const organization = scenario.actors.organization.id;
          const locks = yield* cloudLocks;
          yield* locks.run({
            sql: `create table if not exists e2e_organization_removal_stall (
              organization_id text primary key,
              stalled_until timestamptz not null
            )`,
          });
          yield* locks.run({
            sql: `insert into e2e_organization_removal_stall (organization_id, stalled_until)
              values ($1, now() + interval '3 minutes')`,
            params: [organization],
          });
          const running = locks.run({
            sql: `update hosted_organization_removal set status = 'running', finished_at = null
              where organization_id = $1`,
            params: [organization],
          });
          const release = locks.run({
            sql: "delete from e2e_organization_removal_stall where organization_id = $1",
            params: [organization],
          });
          // A removal left `done` is never started; put it back before the stall ends.
          yield* Effect.addFinalizer(() => Effect.ignore(Effect.andThen(running, release)));
          yield* Scope.close(scope, Exit.void);
          // The erasure has not run: the organization row is still there. Its record says done.
          yield* locks.run({
            sql: `update hosted_organization_removal set status = 'done', finished_at = now()
              where organization_id = $1`,
            params: [organization],
          });
          const files = {
            report: `${target.directory}/report/removal-settlement/done-${id}/${removalSettlementFile}`,
            stalls: `${target.directory}/${removalStallsFile}`,
          };
          const checked = yield* evidence.step(
            "A removal recorded done with its organization row still there is not finished",
            settleRemovals(fixtures, files, { ids: [id], within: 5_000 }).pipe(Effect.exit),
          );
          // The check must fail here: passing would take the record's word over the row.
          expect(Exit.isFailure(checked) ? "failed" : "passed").toBe("failed");
          const stuck = Exit.isFailure(checked)
            ? (Cause.squash(checked.cause) as { _tag?: string; message: string })
            : { message: "" };
          expect(stuck._tag).toBe("RemovalsUnfinished");
          expect(stuck.message).toContain(
            `(scenario ${id}, organization ${organization}) has not finished: wait-for-organization since `,
          );
          const report = yield* (yield* FileSystem.FileSystem)
            .readFileString(files.report)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RemovalSettlement))),
            );
          expect(report.last?.unfinished).toMatchObject([
            { scenario: id, phase: "wait-for-organization", status: "done" },
          ]);
          expect(report.last?.finished).toEqual([]);

          yield* running;
          yield* release;
          const settled = yield* evidence.step(
            "Put back to running and released, the removal finishes",
            settleRemovals(fixtures, files, { ids: [id] }),
          );
          expect(settled.last?.finished.map((removal) => removal.scenario)).toEqual([id]);
        }),
      ),
    // The released start waits for the recovery alarm, at most 60 s apart, or the minute cron.
    { timeout: 150_000 },
  );
});
