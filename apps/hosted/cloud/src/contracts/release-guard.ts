/** A deploy guard's refusal, reported from the Alchemy process to the test-stage command that ran it. */
import { Schema } from "effect";

/** The stage's earlier release is not live, so this release would break it. Nothing was changed. */
export class McpSessionReleaseBlocked extends Schema.TaggedError<McpSessionReleaseBlocked>()(
  "McpSessionReleaseBlocked",
  { message: Schema.String },
) {}

/** The file, named by the test-stage command, where `alchemy deploy` records a guard's refusal. */
export const releaseRefusalReport = "TEST_STAGE_RELEASE_REFUSAL_REPORT";

export const ReleaseRefusal = Schema.fromJsonString(McpSessionReleaseBlocked);

/**
 * `test-stage deploy` exits with this status, and only this one, when a release guard refused the
 * stage. The PR preview workflow recreates its own disposable stage on it.
 */
export const releaseRefusedExitStatus = 3;
