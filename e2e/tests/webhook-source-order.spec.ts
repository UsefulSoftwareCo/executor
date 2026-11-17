/**
 * Pending webhook sources are served first in, first out: a source whose intent is saved again, by
 * linking it again or configuring it, is served in its turn while new sources keep arriving; sources
 * returned to the queue by a failure outside their attempt, or linked again before every sweep,
 * keep no newer source waiting. And the lease is untouched: a source linked again while a sweep
 * holds its lease is neither claimed by a second sweep nor forgotten, and two sweeps that both read
 * the same pending source serve it once. The pending query keeps its order from its index.
 *
 * The cases run in `packages/sdk/scripts/webhook-sources-fixture.ts`, the SDK's real webhook-source
 * reconciliation on PGlite in memory, with apps that have no deployment so that serving a source
 * needs no external call. Each case has a database of its own, so its queue holds only the sources
 * it created, whatever runs beside the scenario; all run in one process, started once. The cases
 * count sweeps and read stored state; none depends on timing.
 * `app-account-webhooks.spec.ts` checks the same through the deployed product.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";

const Starvation = Schema.Struct({
  before: Schema.optional(Schema.String),
  pendingAfterSave: Schema.optional(Schema.String),
  servedInRound: Schema.NullOr(Schema.Number),
  rounds: Schema.Number,
  limit: Schema.Number,
});
const Fairness = Schema.Struct({
  servedInSweep: Schema.NullOr(Schema.Number),
  rounds: Schema.Number,
  limit: Schema.Number,
  maxOldClaims: Schema.optional(Schema.Number),
});
const SetupCompleted = Schema.Struct({
  pendingAfterSetup: Schema.String,
  servedInRound: Schema.NullOr(Schema.Number),
  rounds: Schema.Number,
  limit: Schema.Number,
});
const WaitingCheck = Schema.Struct({
  waitingChecks: Schema.Number,
  status: Schema.String,
  retries: Schema.Number,
  pushedAhead: Schema.Boolean,
});
const Race = Schema.Struct({ readsBeforeClaims: Schema.Number, claims: Schema.Number });
const PlanSummary = Schema.Struct({
  nodes: Schema.Array(Schema.String),
  index: Schema.NullOr(Schema.String),
  rowsRead: Schema.Number,
  sorted: Schema.Boolean,
});
const Plan = Schema.Struct({
  pending: Schema.Number,
  leaseUntil: PlanSummary,
  createdAt: PlanSummary,
});
const Lease = Schema.Struct({
  claimsWhileHeld: Schema.Number,
  afterFirst: Schema.optional(Schema.String),
  claimsAfter: Schema.Number,
  finalStatus: Schema.optional(Schema.String),
});

const Cases = Schema.Struct({
  "relink-while-new-arrive": Starvation,
  "configure-while-new-arrive": Starvation,
  "relink-during-lease": Lease,
  "outside-failures-then-new": Fairness,
  "relinks-before-each-sweep-then-new": Fairness,
  "two-sweeps-race": Race,
  "intent-plan": Plan,
  "setup-completed-while-new-arrive": SetupCompleted,
  "waiting-push-after-setup": WaitingCheck,
});

/** Every case of the probe, each on a database of its own that it opened empty, in one process. */
const probe = Effect.gen(function* () {
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner,
    evidence = yield* Evidence;
  const output = yield* processes.string(
    ChildProcess.make("node", ["packages/sdk/scripts/webhook-sources-fixture.ts", "--all"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      extendEnv: false,
    }),
  );
  const run = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        rowsAtOpen: Schema.Record(Schema.String, Schema.Number),
        cases: Schema.Unknown,
      }),
    ),
  )(output.trim().split("\n").at(-1) ?? "");
  yield* evidence.json("webhook-source-rows-at-open.json", run.rowsAtOpen);
  // Every case opened a database of its own, holding no row of another case.
  expect(run.rowsAtOpen).toEqual(
    Object.fromEntries(Object.keys(Cases.fields).map((name) => [name, 0])),
  );
  const results = yield* Schema.decodeUnknownEffect(Cases)(run.cases);
  for (const [name, result] of Object.entries(results))
    yield* evidence.json(`webhook-source-${name}.json`, result);
  return results;
});

layer(TestLive, { excludeTestServices: true })("Webhook source order", (it) => {
  it.effect(scenarios.webhookSourceOrder.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const results = yield* probe;

        yield* evidence.step(
          "A source linked again, or configured again, is served in its turn while new sources keep arriving",
          Effect.sync(() => {
            for (const name of ["relink-while-new-arrive", "configure-while-new-arrive"] as const) {
              const result = results[name];
              // Served once, its intent saved again: pending.
              expect(result, name).toMatchObject({
                before: "needs-setup",
                pendingAfterSave: "pending",
              });
              // Every sweep also finds a full sweep's worth of new sources; the older source is
              // served in the first of them, not left behind.
              expect(result.servedInRound, name).toBe(1);
            }
          }),
        );

        yield* evidence.step(
          "A source linked again while a sweep holds its lease is not claimed by a second sweep, and is served again afterwards",
          Effect.sync(() => {
            expect(results["relink-during-lease"]).toEqual({
              // Only the sweep holding the lease reconciled it.
              claimsWhileHeld: 1,
              // That sweep saw the new link and left the source pending.
              afterFirst: "pending",
              // The next sweep served it again.
              claimsAfter: 2,
              finalStatus: "needs-setup",
            });
          }),
        );

        yield* evidence.step(
          "Sources returned to the queue by a failure outside their attempt, or linked again before every sweep, keep no newer source waiting",
          Effect.sync(() => {
            // Eight sources fail outside their attempt at every run; a sweep serves four. They go
            // to the back of the queue, so the source that joined after them is served by the
            // third sweep, and none of them runs more than twice meanwhile.
            const failing = results["outside-failures-then-new"];
            expect(failing.servedInSweep).not.toBeNull();
            expect(failing.servedInSweep).toBeLessThanOrEqual(3);
            expect(failing.maxOldClaims).toBeLessThanOrEqual(2);
            // Four sources linked again before every sweep join after the new one.
            expect(results["relinks-before-each-sweep-then-new"].servedInSweep).toBe(1);
          }),
        );

        yield* evidence.step(
          "A source whose setup a person completes joins the queue then, though it held a retry time an hour ahead, and the waiting check does not push it back",
          Effect.sync(() => {
            const setup = results["setup-completed-while-new-arrive"];
            expect(setup.pendingAfterSetup).toBe("pending");
            // Every sweep also finds a full sweep's worth of new sources.
            expect(setup.servedInRound).toBe(1);
            // The setup is completed while the waiting check of the same source runs, between its
            // read and its conditional write; that write must not push the source a delay ahead.
            expect(results["waiting-push-after-setup"]).toEqual({
              waitingChecks: 1,
              status: "pending",
              retries: 0,
              pushedAhead: false,
            });
          }),
        );

        yield* evidence.step(
          "Two sweeps that both read the same pending source before either claims it: exactly one serves it",
          Effect.sync(() => {
            expect(results["two-sweeps-race"]).toEqual({
              // Each sweep's two queue reads came before either claimed.
              readsBeforeClaims: 4,
              claims: 1,
            });
          }),
        );

        yield* evidence.step(
          "The pending query takes its order from the existing partial index, reading only what it serves",
          Effect.sync(() => {
            const plan = results["intent-plan"];
            expect(plan.leaseUntil).toMatchObject({
              index: "executor_webhook_sources_intent",
              sorted: false,
            });
            // A sweep's worth of rows out of 2,000 pending.
            expect(plan.leaseUntil.rowsRead).toBeLessThanOrEqual(4);
          }),
        );
      }),
    ),
  );
});
