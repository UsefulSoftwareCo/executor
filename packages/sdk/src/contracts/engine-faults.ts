/**
 * Engine call faults for E2E runs only, from `EXECUTOR_TEST_WORKFLOW_ENGINE_FAULTS` (this list as
 * JSON). A Node host that starts its own workflow runtime (local, and self-host's development
 * entry) reads it only with `EXECUTOR_ENVIRONMENT=e2e`; Cloud only with emulated providers, which
 * only loopback Cloud and `test-e2e-` stages accept. Any other run has none.
 *
 * Each fault fails a run's first `failures` calls of one kind to one authored step name, `before`
 * the engine sees the call or `after` it answered (for a sleep, after the engine waited). It fails
 * with the error an engine would throw for its `answer`, which the host classifies as it would the
 * engine's own: `internal`, a transient internal error; `paused` and `terminated`, the local
 * engine's "Aborting engine: …" for a paused or terminated instance; `relayed`, a failure carrying
 * our marker, as the engine relays a step's own failure.
 *
 * A late fault (`EngineLate`) fails nothing: it holds a run's first `failures` sleeps or
 * sleepUntils of one step name for `lateMillis` before they reach the engine, as a call slow in
 * transit would be, and the engine then answers as it would. A sleepUntil held past its time meets
 * the engine's refusal of a time in the past.
 */
import { Schema } from "effect";
import { WorkflowFailure } from "apps/contracts";
import { workflowFailureMessage } from "./workflow-errors.ts";

export const EngineFault = Schema.Struct({
  /** The engine's name for the call: a sleep, a sleepUntil, or a step of one of these kinds. */
  call: Schema.Literals(["sleep", "until", "do", "mutation", "query"]),
  step: Schema.String.check(Schema.isMaxLength(100)),
  failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  when: Schema.Literals(["before", "after"]),
  answer: Schema.Literals(["internal", "paused", "terminated", "relayed"]),
});
export type EngineFault = typeof EngineFault.Type;
export const EngineLate = Schema.Struct({
  call: Schema.Literals(["sleep", "until"]),
  step: Schema.String.check(Schema.isMaxLength(100)),
  failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  lateMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type EngineLate = typeof EngineLate.Type;
export const EngineFaults = Schema.Array(Schema.Union([EngineFault, EngineLate]));
export type EngineFaultList = typeof EngineFaults.Type;

/** How many calls each configured fault has failed, by run and by the call it fails. */
const faulted = new Map<string, number>();
/**
 * The fault that fails this call to the engine, counting it, or undefined once its failures are
 * spent. `name` is the engine's name for the call, `<kind>:<authored name>:<hash>`.
 */
const counted = <F extends EngineFault | EngineLate>(
  faults: ReadonlyArray<F>,
  run: string,
  name: string,
): F | undefined => {
  for (const fault of faults) {
    if (!name.startsWith(`${fault.call}:${fault.step}:`)) continue;
    const key = `${run}\u0000${fault.call}:${fault.step}`;
    const count = faulted.get(key) ?? 0;
    if (count >= fault.failures) return undefined;
    faulted.set(key, count + 1);
    return fault;
  }
  return undefined;
};
export const engineFaultFor = (
  faults: EngineFaultList | null | undefined,
  run: string,
  name: string,
) =>
  counted(
    (faults ?? []).filter((fault): fault is EngineFault => "answer" in fault),
    run,
    name,
  );
/** How long a late fault holds this sleep or sleepUntil before it reaches the engine, if one does. */
export const engineLateFor = (
  faults: EngineFaultList | null | undefined,
  run: string,
  name: string,
) =>
  counted(
    (faults ?? []).filter((fault): fault is EngineLate => "lateMillis" in fault),
    run,
    name,
  )?.lateMillis;
/** The error an engine would throw for the fault's answer. */
export const engineFaultError = (fault: EngineFault): Error => {
  switch (fault.answer) {
    case "internal":
      return new Error("internal error");
    case "paused":
      return new Error("Aborting engine: User called pause");
    case "terminated":
      return new Error("Aborting engine: User called terminate");
    case "relayed":
      return new Error(
        workflowFailureMessage(new WorkflowFailure({ reason: "execution", retryable: true })),
      );
  }
};
/** The engine call `work`, failed by `fault` before the engine sees it or after it answered. */
export const engineFaultCall = <A>(fault: EngineFault, work: () => Promise<A>): Promise<A> =>
  fault.when === "before"
    ? Promise.reject(engineFaultError(fault))
    : work().then(() => Promise.reject(engineFaultError(fault)));
