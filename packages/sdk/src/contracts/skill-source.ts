/** Static Agent Skills shipped in an app's immutable source snapshot. */
import { Schema } from "effect";
import { SourceFile, SourceFilePath } from "./deployment.ts";

/** Agent Skills format constraints, not Executor execution or storage budgets. */
export const skillFormatLimits = {
  nameCharacters: 64,
  descriptionCharacters: 1024,
  compatibilityCharacters: 500,
} as const;

/** A lowercase alphanumeric skill directory name with single separating hyphens. */
export const AppSkillName = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      value === value.toLowerCase() &&
      /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(value) &&
      [...value].length <= skillFormatLimits.nameCharacters,
  ),
);
/** Frontmatter is metadata only. In particular, allowed-tools never grants execution authority. */
export const AppSkillMetadata = Schema.Struct({
  name: AppSkillName,
  description: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.trim().length > 0 && [...value].length <= skillFormatLimits.descriptionCharacters,
    ),
  ),
  license: Schema.optionalKey(Schema.String),
  compatibility: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(
        (value) =>
          value.trim().length > 0 && [...value].length <= skillFormatLimits.compatibilityCharacters,
      ),
    ),
  ),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  "allowed-tools": Schema.optionalKey(Schema.String),
});
export type AppSkillMetadata = typeof AppSkillMetadata.Type;

/** Files use paths relative to this skill directory; reading one never executes its contents. */
export const AppSkillSource = Schema.Struct({
  ...AppSkillMetadata.fields,
  files: Schema.Array(SourceFile),
});
export type AppSkillSource = typeof AppSkillSource.Type;

/** Invalid skill source prevents publication. Errors identify the file without disclosing its contents. */
export class SkillDefinitionInvalid extends Schema.TaggedError<SkillDefinitionInvalid>()(
  "SkillDefinitionInvalid",
  {
    file: SourceFilePath,
    reason: Schema.Literals([
      "directory",
      "missing-document",
      "frontmatter",
      "metadata",
      "name-mismatch",
    ]),
  },
  { httpApiStatus: 400 },
) {}
