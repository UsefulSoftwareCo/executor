import {
  decodeWorkflowFailure,
  engineCallFailure,
  engineErrorCode,
  hasWorkflowFailureMarker,
} from "../contracts/workflow-errors.ts";
import { errorClassOf } from "./runtime-hop.ts";

export const nativeEngineFailure = (error: unknown) =>
  hasWorkflowFailureMarker(error)
    ? decodeWorkflowFailure(error)
    : engineCallFailure("platform", errorClassOf(error), engineErrorCode(error));
