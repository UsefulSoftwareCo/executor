/** Portable Agent Skills returned by an app factory or loaded from published files. */
import { Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
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

const skillDefinitionFailures = {
  files: (file: string) =>
    `The skill files of “${file}” are invalid: each needs a unique relative path, text content and a SKILL.md document.`,
  directory: (file: string) =>
    `“${file}” is not a valid skill directory. Skill directory names use lowercase letters and digits separated by single hyphens.`,
  "missing-document": (file: string) => `“${file}” is missing.`,
  frontmatter: (file: string) =>
    `“${file}” must start with valid YAML frontmatter between --- lines.`,
  metadata: (file: string) =>
    `The frontmatter of “${file}” needs a valid name and description within the Agent Skills limits.`,
  "name-mismatch": (file: string) => `The name in “${file}” does not match its skill directory.`,
} as const;
/** Invalid selected skill files fail the load. Errors identify the file without disclosing its contents. */
export const SkillDefinitionInvalid = ApiError.define({
  tag: "SkillDefinitionInvalid",
  status: 400,
  fields: {
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
  message: ({ file, reason }) => skillDefinitionFailures[reason](file),
  recorded: ({ reason }) => `The app's skill definition is invalid (${reason})`,
});
export type SkillDefinitionInvalid = typeof SkillDefinitionInvalid.Type;

/** One evaluated catalog cannot contain ambiguous names. */
export const AppSkills = Schema.Array(AppSkillSource).check(
  Schema.makeFilter((skills) => new Set(skills.map((skill) => skill.name)).size === skills.length),
);
/** Short display name for a skill source, such as "GitLab" or an index host name. */
export const SkillServiceName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9 .-]{0,98}[A-Za-z0-9])?$/u),
);
/**
 * A skill loader failure shown to people. `message` is the explanation they read; write it for
 * them and never include URLs, tokens or response bodies. `reason` selects the title and whether
 * a retry can help. Custom loaders throw this error to get the same presentation as built-ins.
 * With `source`, `missing` names what the service's answer points to as missing: the `repository`,
 * or the branch or tag (`ref`). It may be missing, or not readable with the request's credentials.
 * Without it, the source's settings or the paths it lists are not valid.
 * These fields choose the explanation; they never show that the failure lies outside Executor.
 */
export class SkillLoadFailed extends Schema.TaggedError<SkillLoadFailed>()("SkillLoadFailed", {
  reason: Schema.Literals([
    "source",
    "request",
    "rate_limited",
    "document",
    "limit",
    "changed",
    "encoding",
  ]),
  // Error instances read an omitted message as "", so an empty message means none was given.
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  missing: Schema.optional(Schema.Literals(["repository", "ref"])),
}) {}
/** Bounds shared by skill loaders across all app hosts. */
export const skillLoadLimits = {
  files: 1000,
  fileBytes: 2_000_000,
  totalBytes: 20_000_000,
  concurrency: 8,
  /** The request that checks whether a kept catalog's publication changed. */
  checkMillis: 5_000,
} as const;
/** Invocation-owned transport and cancellation, supplied by the app context. */
export interface SkillTransport {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}
/** A custom loader's transport and the service name shown when a request fails. */
export interface SkillReaderOptions extends SkillTransport {
  readonly service: string;
}
/**
 * Catalog reuse shared by remote skill loaders. Pass `ctx.cache` to keep the loaded catalog;
 * without it every read fetches the source again. Unlike an MCP tool catalog, a skill catalog
 * past `freshFor` is not served while it refreshes: the read first asks the source whether its
 * publication changed, so agents never read skills that a refresh replaces moments later.
 */
export interface SkillCacheOptions {
  readonly cache?: import("./cache.ts").AppCache;
  /** Reuse the catalog without asking the source for this duration. Defaults to five minutes. */
  readonly freshFor?: import("effect").Duration.Input;
  /**
   * Keep the catalog this long after `freshFor`. A read then confirms it with one request and
   * loads the files again only when the publication changed. Defaults to one day.
   */
  readonly staleFor?: import("effect").Duration.Input;
}
/**
 * Whose access reads the repository. A public repository needs neither field. A private one takes
 * a GitHub account and its token, sent on every request of this read. The token comes only with
 * its account, so the catalog is cached in that account's scope and failures name the account.
 */
export type GitHubSkillsAccount = import("./cache.ts").AccountCredential<{
  /**
   * The account's token or its handle, such as `account.fields.token`. Its provider declares
   * hosts `github.com` and `raw.githubusercontent.com`, so app code never holds the value.
   */
  readonly token: string;
}>;
/**
 * A GitHub repository and an optional immutable commit, tag or branch. With a cache, a branch or
 * tag is resolved again once the catalog is past `freshFor`, and each commit's file list is kept.
 */
export type GitHubSkillsOptions = SkillTransport &
  SkillCacheOptions &
  GitHubSkillsAccount & {
    readonly repo: string;
    readonly path?: string;
    readonly ref?: string;
  };
/** A published directory index, including its listed skill documents and text references. */
export interface WellKnownSkillsOptions extends SkillTransport, SkillCacheOptions {
  readonly url: string;
}

/** A folder in the deployed package; omitted path selects skills/. No host filesystem access. */
export interface FolderSkillsOptions {
  readonly files: readonly SkillFile[];
  readonly path?: string;
}
