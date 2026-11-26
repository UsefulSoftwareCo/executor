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
              expect(result, name).toMatchObject({
                before: "needs-setup",
                pendingAfterSave: "pending",
              });
              expect(result.servedInRound, name).toBe(1);
            }
          }),
        );

        yield* evidence.step(
          "A source linked again while a sweep holds its lease is not claimed by a second sweep, and is served again afterwards",
          Effect.sync(() => {
            expect(results["relink-during-lease"]).toEqual({
              claimsWhileHeld: 1,
              afterFirst: "pending",
              claimsAfter: 2,
              finalStatus: "needs-setup",
            });
          }),
        );

        yield* evidence.step(
          "Sources returned to the queue by a failure outside their attempt, or linked again before every sweep, keep no newer source waiting",
          Effect.sync(() => {
            const failing = results["outside-failures-then-new"];
            expect(failing.servedInSweep).not.toBeNull();
            expect(failing.servedInSweep).toBeLessThanOrEqual(3);
            expect(failing.maxOldClaims).toBeLessThanOrEqual(2);
            expect(results["relinks-before-each-sweep-then-new"].servedInSweep).toBe(1);
          }),
        );

        yield* evidence.step(
          "A source whose setup a person completes joins the queue then, though it held a retry time an hour ahead, and the waiting check does not push it back",
          Effect.sync(() => {
            const setup = results["setup-completed-while-new-arrive"];
            expect(setup.pendingAfterSetup).toBe("pending");
            expect(setup.servedInRound).toBe(1);
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
            expect(plan.leaseUntil.rowsRead).toBeLessThanOrEqual(4);
          }),
        );
      }),
    ),
  );
});
