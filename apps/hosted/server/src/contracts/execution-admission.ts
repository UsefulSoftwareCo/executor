import { Context, Effect, Schema } from "effect";
import type { OrganizationId } from "./organization.ts";

/** A host refused a new execution before running user code. */
export class ExecutionLimitReached extends Schema.TaggedError<ExecutionLimitReached>()(
  "ExecutionLimitReached",
  {},
  { httpApiStatus: 402 },
) {}
/** The host could not authorize a new execution; no tool body was run. */
export class ExecutionAdmissionUnavailable extends Schema.TaggedError<ExecutionAdmissionUnavailable>()(
  "ExecutionAdmissionUnavailable",
  {},
  { httpApiStatus: 503 },
) {}
/** Optional hosted policy, invoked only after organization and app authorization. */
export const ExecutionAdmission = Context.Reference<
  (
    organization: OrganizationId,
  ) => Effect.Effect<void, ExecutionLimitReached | ExecutionAdmissionUnavailable>
>("hosted/ExecutionAdmission", { defaultValue: () => () => Effect.void });
