import { ReleaseVersion } from "@executor-js/utils/release-version";
import { Schema } from "effect";
import snapshot from "./release.json" with { type: "json" };

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Notes = Schema.Struct({
  version: ReleaseVersion,
  announcement: Schema.optionalKey(Schema.String),
  notes: Schema.Array(Schema.Struct({ area: Schema.String, text: Schema.String })),
});
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export const McpProfiles = Schema.NonEmptyArray(
  Schema.Struct({
    mode: Schema.String,
    profiles: Schema.NonEmptyArray(
      Schema.Struct({
        protocol: Schema.String,
        capabilities: JsonObject,
        tools: Schema.NonEmptyArray(
          Schema.Struct({
            name: Schema.String,
            description: Schema.String,
            inputSchema: JsonObject,
          }),
        ),
      }),
    ),
  }),
);
const ReferenceSnapshot = Schema.Struct({
  version: ReleaseVersion,
  source: Sha,
  exportCommit: Sha,
  publishedAt: Schema.String,
  framework: Schema.String,
  minimumNodeVersion: Schema.String,
  cli: Schema.Record(Schema.String, Schema.String),
  mcp: McpProfiles,
  selfHost: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      type: Schema.String,
      fallback: Schema.String,
      imageDefault: Schema.optionalKey(Schema.String),
    }),
  ),
  skills: Schema.Record(Schema.String, Schema.String),
  notes: Schema.Array(Notes),
});

export type ReferenceRelease = typeof ReferenceSnapshot.Type;

export function decodeReferenceRelease(input: unknown): ReferenceRelease {
  const snapshot = Schema.decodeUnknownSync(ReferenceSnapshot)(input);
  if (snapshot.notes[0]?.version !== snapshot.version)
    throw new Error(`Reference release history does not start at ${snapshot.version}`);
  return snapshot;
}

export const referenceRelease = decodeReferenceRelease(snapshot);
