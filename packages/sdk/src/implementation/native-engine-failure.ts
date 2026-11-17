/** What a failed call to a native workflow engine becomes in a run, on every host. */
import {
  decodeWorkflowFailure,
  engineCallFailure,
  engineErrorCode,
  hasWorkflowFailureMarker,
} from "../contracts/workflow-errors.ts";
import { errorClassOf } from "./runtime-hop.ts";

/**
 * A failure carrying our marker is ours, relayed by the engine, and passes on as itself. Any other
 * is the platform's answer: its standard class name and a code read from its message
 * (`engineErrorCode`), never the message.
 */
export const nativeEngineFailure = (error: unknown) =>
  hasWorkflowFailureMarker(error)
    ? decodeWorkflowFailure(error)
    : engineCallFailure("platform", errorClassOf(error), engineErrorCode(error));
