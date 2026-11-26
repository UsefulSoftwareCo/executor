import { Schema } from "effect";

export class McpSessionReleaseBlocked extends Schema.TaggedError<McpSessionReleaseBlocked>()(
  "McpSessionReleaseBlocked",
  { message: Schema.String },
) {}

export const releaseRefusalReport = "TEST_STAGE_RELEASE_REFUSAL_REPORT";

export const ReleaseRefusal = Schema.fromJsonString(McpSessionReleaseBlocked);

export const releaseRefusedExitStatus = 3;
