import { Context, Schema, type Effect } from "effect";
import { VersionMetadata, SourceFilePath, type SourceTextFile } from "@executor-js/sdk/core";

export class SourceFormatter extends Context.Service<
  SourceFormatter,
  {
    readonly format: (
      files: ReadonlyArray<SourceTextFile>,
    ) => Effect.Effect<ReadonlyArray<SourceTextFile>>;
  }
>()("app-management/SourceFormatter") {}

export const sourceDisplayLimits = {
  fileBytes: 256 * 1024,
} as const;

export const sourceDisplayInlineLimits = {
  fileBytes: 64 * 1024,
  requestBytes: 256 * 1024,
} as const;

export const SourceFileBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SourceDisplayFile = Schema.Struct({
  path: SourceFilePath,
  size: SourceFileBytes,
  content: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Literal(true)),
});
export type SourceDisplayFile = typeof SourceDisplayFile.Type;

export const SourceDisplayEntry = Schema.Struct({
  path: SourceFilePath,
  size: SourceFileBytes,
  content: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Literal(true)),
});
export type SourceDisplayEntry = typeof SourceDisplayEntry.Type;

export const SourceDisplayEntries = Schema.NonEmptyArray(SourceDisplayEntry);

export const VersionDisplay = Schema.Struct({
  ...VersionMetadata.fields,
  files: SourceDisplayEntries,
});
export type VersionDisplay = typeof VersionDisplay.Type;

export const SourceDisplayFileQuery = { path: SourceFilePath };
