/** Portable Agent Skills returned by an app factory or loaded from published files. */
import { Schema } from "effect";
/** Canonical resource path within one skill. */
export const SkillFilePath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);
/** UTF-8 text resource. Reading a resource never executes it. */
export const SkillFile = Schema.Struct({ path: SkillFilePath, content: Schema.String });
export type SkillFile = typeof SkillFile.Type;

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
  files: Schema.Array(SkillFile).check(
    Schema.makeFilter(
      (files) =>
        files.some((file) => file.path === "SKILL.md") &&
        new Set(files.map((file) => file.path)).size === files.length,
    ),
  ),
});
export type AppSkillSource = typeof AppSkillSource.Type;

/** Invalid selected skill files fail the load. Errors identify the file without disclosing its contents. */
export class SkillDefinitionInvalid extends Schema.TaggedError<SkillDefinitionInvalid>()(
  "SkillDefinitionInvalid",
  {
    file: SkillFilePath,
    reason: Schema.Literals([
      "files",
      "directory",
      "missing-document",
      "frontmatter",
      "metadata",
      "name-mismatch",
    ]),
  },
  { httpApiStatus: 400 },
) {}

/** One evaluated catalog cannot contain ambiguous names. */
export const AppSkills = Schema.Array(AppSkillSource).check(
  Schema.makeFilter((skills) => new Set(skills.map((skill) => skill.name)).size === skills.length),
);
/** Safe loader failure; source bodies and authorization headers remain private. */
export class SkillLoadFailed extends Schema.TaggedError<SkillLoadFailed>()("SkillLoadFailed", {
  reason: Schema.Literals(["source", "request", "document", "limit", "changed", "encoding"]),
}) {}
/** Bounds shared by skill loaders across all app hosts. */
export const skillLoadLimits = {
  files: 1000,
  fileBytes: 2_000_000,
  totalBytes: 20_000_000,
  concurrency: 8,
} as const;
/** Invocation-owned transport and cancellation, supplied by the app context. */
export interface SkillTransport {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}
/** A public GitHub repository and an optional immutable commit, tag or branch. */
export interface GitHubSkillsOptions extends SkillTransport {
  readonly repo: string;
  readonly path?: string;
  readonly ref?: string;
}
/** A published directory index, including its listed skill documents and text references. */
export interface WellKnownSkillsOptions extends SkillTransport {
  readonly url: string;
}

/** A folder in the deployed package; omitted path selects skills/. No host filesystem access. */
export interface FolderSkillsOptions {
  readonly files: readonly SkillFile[];
  readonly path?: string;
}
