import { Schema } from "effect";
import { DeploymentMetadata, SourceFilePath } from "@executor-js/sdk/core";

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

/** One read-only file with display-formatted text. Stored source is never rewritten. */
export const SourceDisplayFile = Schema.Struct({
  path: SourceFilePath,
  size: SourceFileBytes,
  content: Schema.String,
});
export type SourceDisplayFile = typeof SourceDisplayFile.Type;

/** A listed file. content is absent when the file exceeds the inline budget. */
export const SourceDisplayEntry = Schema.Struct({
  path: SourceFilePath,
  size: SourceFileBytes,
  content: Schema.optionalKey(Schema.String),
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
