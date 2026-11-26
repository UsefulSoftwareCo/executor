/** Failure markers survive the native workflow engine's error serialization. */
import { Schema, Option } from "effect";
import { WorkflowFailure, WorkflowRunFailure } from "apps/contracts";

const DetailJson = Schema.fromJsonString(WorkflowRunFailure);
const marker = /ExecutorWorkflowFailure\(([a-z_]+),(true|false)\)(?: (\{[\s\S]*\}))?/;

/** The failing step and app error a failure carries, if any. */
export const workflowFailureDetail = ({
  step,
  errorName,
  message,
}: WorkflowFailure): WorkflowRunFailure | undefined =>
  step === undefined && errorName === undefined && message.length === 0
    ? undefined
    : {
        ...(step === undefined ? {} : { step }),
        ...(errorName === undefined ? {} : { errorName }),
        ...(message.length === 0 ? {} : { message }),
      };

/**
 * Encode the reason, retry flag and the app's bounded, secret-free error detail. The native engine
 * keeps only an error message, so the detail travels as JSON after the marker.
 */
export const workflowFailureMessage = (failure: WorkflowFailure) => {
  const detail = workflowFailureDetail(failure);
  return `ExecutorWorkflowFailure(${failure.reason},${failure.retryable})${
    detail === undefined ? "" : ` ${Schema.encodeSync(DetailJson)(detail)}`
  }`;
};
/** Whether a native error carries our failure marker, so the failure is ours and not the engine's. */
export const hasWorkflowFailureMarker = (error: unknown) =>
  Schema.is(WorkflowFailure)(error) || (error instanceof Error && marker.test(error.message));

/**
 * Where a call from a run's body to the workflow engine stopped: the platform's engine itself, the
 * runner's call to Executor's host, which did not answer or answered unreadably, or the runner.
 */
export type EngineCallHop = "platform" | "host" | "runner";
/** An engine call failure travels as these fields, which every release since detail existed reads. */
const engineCallName = "WorkflowEngineCallFailed";
const engineCallForm =
  /^hop=(platform|host|runner); class=([A-Za-z]{1,40}); code=([A-Za-z0-9_.-]{1,40})$/;
const word = (value: string) => (/^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "other");
/**
 * A call to the engine that failed in transit or in the engine, not in the app's code: retryable,
 * and recorded only as its hop, its error's standard class name and a classified code. Never the
 * platform's message text, which can repeat the app's step name or input.
 */
export const engineCallFailure = (hop: EngineCallHop, errorClass: string, code: string) =>
  new WorkflowFailure({
    reason: "engine",
    retryable: true,
    errorName: engineCallName,
    message: `hop=${hop}; class=${/^[A-Za-z]{1,40}$/.test(errorClass) ? errorClass : "other"}; code=${word(code)}`,
  });
/** The hop, class and code of an engine call failure, or undefined for any other failure. */
export const engineCallOf = (failure: WorkflowFailure) => {
  if (failure.reason !== "engine" || !failure.retryable || failure.errorName !== engineCallName)
    return undefined;
  const match = engineCallForm.exec(failure.message);
  if (match === null) return undefined;
  return { hop: match[1] as EngineCallHop, errorClass: match[2]!, code: match[3]! };
};

/**
 * What an engine's error says, as a code, from its message alone; the message is never kept.
 * The local engine (miniflare's `workflows/binding.worker.js`) aborts a paused, restarted or
 * terminated instance's calls with "Aborting engine: …", and refuses a `sleepUntil` in the past
 * (`pastSleep`).
 * Cloudflare's engine names instance states as `instance.<state>`. Neither documents a full list,
 * so a message no rule recognises is `unclassified`.
 */
/**
 * The engine's refusal of a `sleepUntil` whose time has passed, in each engine's words:
 * - "You can't sleep until a time in the past, time-traveler": upstream's engine (miniflare's
 *   `binding.worker.js`, and `@alchemy.run/cloudflare-runtime`'s copy of it);
 * - "Sleep deadline is in the past": our recovery change to that engine's `sleepUntil`, which keeps
 *   a step's duration across a restart (`patches/@alchemy.run%2Fcloudflare-runtime@*.patch`). Local,
 *   self-host and loopback Cloud run this one. A change to the patch's wording must change this too.
 */
const pastSleep = /sleep until a time in the past|sleep deadline is in the past/i;
export const engineErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Aborting engine:")) return "aborted";
  if (pastSleep.test(message)) return "past";
  const instance = /instance\.([a-z_]+)/.exec(message)?.[0];
  if (instance !== undefined) return instance;
  if (/terminat/i.test(message)) return "terminated";
  if (/internal error|internal_server/i.test(message)) return "internal";
  if (/overloaded|too many requests|rate.?limit/i.test(message)) return "overloaded";
  if (/network connection lost|disconnected/i.test(message)) return "disconnected";
  if (/timed out|timeout/i.test(message)) return "timeout";
  return "unclassified";
};
/**
 * The codes of a call that failed on its way, not by the engine's choice: an internal error or
 * overload the engine reports as passing, a lost connection, or a host that never answered. Any
 * other code, an aborted, terminated or paused instance, a refusal, an instance state, or a
 * failure no rule recognises, is the engine's answer and is not repeated.
 */
const transientCodes: ReadonlySet<string> = new Set([
  "internal",
  "overloaded",
  "disconnected",
  "timeout",
  "unanswered",
]);
/** Whether a failed engine call is safe and worth calling again: a transient failure in transit. */
export const transientEngineCall = (failure: WorkflowFailure) => {
  const call = engineCallOf(failure);
  return call !== undefined && transientCodes.has(call.code) ? call : undefined;
};

/** Native engines can wrap exception names; recover only our validated marker and detail. */
export const decodeWorkflowFailure = (error: unknown): WorkflowFailure => {
  if (Schema.is(WorkflowFailure)(error)) return error;
  const message = error instanceof Error ? error.message : "";
  const match = marker.exec(message);
  if (match !== null) {
    const parsed = Schema.decodeUnknownOption(WorkflowFailure.fields.reason)(match[1]);
    if (Option.isSome(parsed)) {
      const detail =
        match[3] === undefined ? Option.none() : Schema.decodeUnknownOption(DetailJson)(match[3]);
      return new WorkflowFailure({
        reason: parsed.value,
        retryable: match[2] === "true",
        ...Option.getOrElse(detail, () => ({})),
      });
    }
  }
  return new WorkflowFailure({ reason: "engine", retryable: true });
};
