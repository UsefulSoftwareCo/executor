import { Context, Schema, type Effect } from "effect";
import { DeploymentMetadata, SourceFilePath, type SourceTextFile } from "@executor-js/sdk/core";

/**
 * Formats source text for display only; stored source is never rewritten. A file the formatter
 * cannot parse keeps its original text. Each host chooses where formatting runs, because the
 * parsers are large: see `localSourceFormatter` in `@executor-js/app-management/source-format`.
 */
export class SourceFormatter extends Context.Service<
  SourceFormatter,
  {
    /** Every given file, in order, with display-formatted contents. */
    readonly format: (
      files: ReadonlyArray<SourceTextFile>,
    ) => Effect.Effect<ReadonlyArray<SourceTextFile>>;
  }
>()("app-management/SourceFormatter") {}

/** Bound parser work for one file; larger files remain readable as their original text. */
export const sourceDisplayLimits = {
  fileBytes: 256 * 1024,
} as const;

/**
 * Bound the contents inlined, and so formatted, in a display listing. Larger files are listed
 * by path and size; the viewer reads each one separately when it is selected.
 */
export const sourceDisplayInlineLimits = {
  fileBytes: 64 * 1024,
  requestBytes: 256 * 1024,
} as const;

/** UTF-8 size of the stored file, before display formatting. */
export const SourceFileBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One read-only file with display-formatted text. Stored source is never rewritten. A public file
 * that is not UTF-8 text, or is stored by its blob, has no text and is marked `binary`.
 */
export const SourceDisplayFile = Schema.Struct({
  path: SourceFilePath,
  size: SourceFileBytes,
  content: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Literal(true)),
});
export type SourceDisplayFile = typeof SourceDisplayFile.Type;

/** A listed file. content is absent when the file exceeds the inline budget or is binary. */
export const SourceDisplayEntry = Schema.Struct({
  path: SourceFilePath,
  size: SourceFileBytes,
  content: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Literal(true)),
});
export type SourceDisplayEntry = typeof SourceDisplayEntry.Type;

/** Every source file, in stored order, with contents inlined only within the budget. */
export const SourceDisplayEntries = Schema.NonEmptyArray(SourceDisplayEntry);

/** A retained deployment's display listing. The deployment ID pins single-file reads. */
export const DeploymentDisplay = Schema.Struct({
  ...DeploymentMetadata.fields,
  files: SourceDisplayEntries,
});
export type DeploymentDisplay = typeof DeploymentDisplay.Type;

/** Select one file of an immutable revision or deployment for a display read. */
export const SourceDisplayFileQuery = { path: SourceFilePath };
