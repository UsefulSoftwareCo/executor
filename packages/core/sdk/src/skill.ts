// ---------------------------------------------------------------------------
// Agent Skills — the SKILL.md standard (https://agentskills.io/specification)
// saved into the workspace. Row → public projection, the operation inputs, and
// the pure validation that turns a set of uploaded files into a skill.
//
// A skill IS a directory: a SKILL.md with YAML frontmatter (`name`,
// `description`, a few optional fields) followed by markdown instructions, plus
// any bundled files (`references/`, `scripts/`, `assets/`). We store the whole
// directory as one row so the MCP host can serve it back file-by-file with
// digests, which is what the MCP Skills Extension (SEP-2640) requires.
//
// Owner-scoped like a connection: an `org` skill is shared with everyone in the
// workspace, a `user` skill is personal. Identity is `(owner, name)`.
// ---------------------------------------------------------------------------

import { Option, Result, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import type { SkillRow } from "./core-schema";
import { InvalidSkillError } from "./errors";
import { SkillName, type Owner } from "./ids";

/** One file as uploaded: a relative POSIX path and its UTF-8 text. */
export interface SkillFileInput {
  readonly path: string;
  readonly content: string;
}

/** One file in a skill's manifest: what the MCP Skills Extension lists. */
export interface SkillFileEntry {
  /** Relative to the skill root, `/`-separated. `SKILL.md` for the root file. */
  readonly path: string;
  /** Byte length of the UTF-8 content. */
  readonly size: number;
  /** `sha256:<64 lowercase hex>` over the same bytes. */
  readonly digest: string;
}

export type SkillFile = SkillFileEntry & { readonly content: string };

export interface SkillSummary {
  readonly owner: Owner;
  readonly name: SkillName;
  readonly description: string;
  /** The SKILL.md frontmatter, verbatim, every field the author wrote. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** The manifest — paths, sizes, digests — without content. */
  readonly files: readonly SkillFileEntry[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Skill extends Omit<SkillSummary, "files"> {
  readonly files: readonly SkillFile[];
}

/** Save (create or replace in place) the skill the files describe. The name
 *  comes from the SKILL.md frontmatter, never from the caller. */
export interface SaveSkillInput {
  readonly owner: Owner;
  readonly files: readonly SkillFileInput[];
}

export interface SkillRef {
  readonly owner: Owner;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Limits and reserved names
// ---------------------------------------------------------------------------

export const SKILL_MD_PATH = "SKILL.md";
/** Files per skill, SKILL.md included. */
export const SKILL_MAX_FILES = 64;
/** Total UTF-8 bytes across every file of one skill. */
export const SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

/** Names the MCP `skills` tool already answers with Executor's own docs; a
 *  workspace skill under one of them would be unreachable by name. */
export const SKILL_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "execute",
  "create-artifact",
  "artifact-style",
]);

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `name` satisfies the specification's `name` rules. */
export const isValidSkillName = (name: string): boolean =>
  name.length >= 1 && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface ParsedSkillMarkdown {
  readonly name: SkillName;
  readonly description: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** The markdown after the closing `---`, trimmed. */
  readonly body: string;
}

const invalid = (reason: string) => Result.fail(new InvalidSkillError({ reason }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Locate the frontmatter block: `---` on the first line, `---` alone on a
 *  later line. Returns the YAML between them and the body after. */
const splitFrontmatter = (
  markdown: string,
): Option.Option<{ readonly yaml: string; readonly body: string }> => {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return Option.none();
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) return Option.none();
  return Option.some({
    yaml: lines.slice(1, closing).join("\n"),
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
  });
};

const tryYaml = (text: string): Result.Result<unknown, InvalidSkillError> =>
  Result.try({
    try: () => parseYaml(text) as unknown,
    catch: () => new InvalidSkillError({ reason: "SKILL.md frontmatter is not valid YAML." }),
  });

/**
 * Quote the value of every top-level `key: value` line whose value contains
 * a colon and is not already quoted or a block scalar. The most common
 * frontmatter authored for other clients is technically invalid YAML —
 * `description: Use when: the user asks about PDFs` — and their parsers
 * happen to accept it. Rewriting only unquoted scalar values keeps nested
 * mappings (`metadata:`) and block scalars (`description: >`) untouched.
 */
const quoteUnquotedScalars = (yaml: string): string =>
  yaml
    .split("\n")
    .map((line) => {
      const match = /^([ \t]*[A-Za-z0-9_-]+):[ \t]+(.*)$/.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      if (value === undefined || key === undefined) return line;
      const trimmed = value.trim();
      if (
        !trimmed.includes(":") ||
        /^["'>|]/.test(trimmed) ||
        trimmed.startsWith("[") ||
        trimmed.startsWith("{")
      ) {
        return line;
      }
      return `${key}: ${JSON.stringify(trimmed)}`;
    })
    .join("\n");

/** Parse the frontmatter block, retrying once with unquoted colon-bearing
 *  values quoted so skills written for lenient clients still load. */
const parseFrontmatterYaml = (yaml: string): Result.Result<unknown, InvalidSkillError> => {
  const strict = tryYaml(yaml);
  if (Result.isSuccess(strict)) return strict;
  const quoted = quoteUnquotedScalars(yaml);
  return quoted === yaml ? strict : tryYaml(quoted);
};

/**
 * Split a SKILL.md into frontmatter and body and validate the required fields.
 *
 * Strict on what the specification makes strict (`name` shape, `description`
 * presence and length, `compatibility` length, `metadata` shape) and open on
 * everything else: unknown keys are kept verbatim, because the MCP Skills
 * Extension promises hosts the frontmatter exactly as the author wrote it.
 */
export const parseSkillMarkdown = (
  markdown: string,
): Result.Result<ParsedSkillMarkdown, InvalidSkillError> => {
  const split = splitFrontmatter(markdown);
  if (Option.isNone(split)) {
    return invalid(
      "SKILL.md must begin with a `---` line, followed by YAML frontmatter and a closing `---` line.",
    );
  }
  const { yaml, body } = split.value;

  const parsed = parseFrontmatterYaml(yaml);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const frontmatter = parsed.success;
  if (!isRecord(frontmatter)) {
    return invalid("SKILL.md frontmatter must be a YAML mapping of fields.");
  }

  const name = frontmatter.name;
  if (typeof name !== "string" || !isValidSkillName(name)) {
    return invalid(
      "Frontmatter `name` must be 1–64 characters of lowercase letters, digits, and single hyphens, and cannot start or end with a hyphen.",
    );
  }
  if (SKILL_RESERVED_NAMES.has(name)) {
    return invalid(`\`${name}\` is reserved for Executor's built-in docs; choose another name.`);
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return invalid("Frontmatter `description` is required and must be a non-empty string.");
  }
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return invalid(
      `Frontmatter \`description\` must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  if ("compatibility" in frontmatter) {
    const compatibility = frontmatter.compatibility;
    if (
      typeof compatibility !== "string" ||
      compatibility.length === 0 ||
      compatibility.length > SKILL_COMPATIBILITY_MAX_LENGTH
    ) {
      return invalid(
        `Frontmatter \`compatibility\` must be a string of 1–${SKILL_COMPATIBILITY_MAX_LENGTH} characters.`,
      );
    }
  }
  if ("license" in frontmatter && typeof frontmatter.license !== "string") {
    return invalid("Frontmatter `license` must be a string.");
  }
  if ("allowed-tools" in frontmatter && typeof frontmatter["allowed-tools"] !== "string") {
    return invalid("Frontmatter `allowed-tools` must be a space-separated string.");
  }
  if ("metadata" in frontmatter) {
    const metadata = frontmatter.metadata;
    if (!isRecord(metadata) || Object.values(metadata).some((v) => typeof v !== "string")) {
      return invalid("Frontmatter `metadata` must be a mapping of string keys to string values.");
    }
  }

  return Result.succeed({
    name: SkillName.make(name),
    description: description.trim(),
    frontmatter,
    body,
  });
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** `sha256:<hex>` of the UTF-8 encoding of `content` — the digest shape the
 *  MCP Skills Extension specifies. Web Crypto, so it runs on Node, Bun, and
 *  workerd alike. */
export const digestSkillContent = async (content: string): Promise<string> =>
  `sha256:${toHex(await crypto.subtle.digest("SHA-256", encoder.encode(content)))}`;

export const skillContentByteLength = (content: string): number =>
  encoder.encode(content).byteLength;

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters in paths
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A relative POSIX path inside a skill: no leading `/`, no `.`/`..` segments,
 *  no empty segments, no backslashes, no control characters. */
export const isValidSkillFilePath = (path: string): boolean => {
  if (path.length === 0 || path.length > 512) return false;
  if (path.includes("\\") || CONTROL_CHARACTERS.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const compareSkillPaths = (a: SkillFileInput, b: SkillFileInput): number =>
  a.path === SKILL_MD_PATH
    ? -1
    : b.path === SKILL_MD_PATH
      ? 1
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0;

export interface PreparedSkill {
  readonly parsed: ParsedSkillMarkdown;
  /** SKILL.md first, then the rest in path order. */
  readonly files: readonly SkillFile[];
}

/**
 * Validate an uploaded file set and produce the parsed SKILL.md plus the
 * normalized, digested file list — exactly what gets stored.
 *
 * Async only for the digests; everything else is pure.
 */
export const prepareSkillFiles = async (
  inputs: readonly SkillFileInput[],
): Promise<Result.Result<PreparedSkill, InvalidSkillError>> => {
  if (inputs.length === 0) return invalid("A skill needs at least a SKILL.md file.");
  if (inputs.length > SKILL_MAX_FILES) {
    return invalid(`A skill can have at most ${SKILL_MAX_FILES} files.`);
  }
  const seen = new Set<string>();
  for (const file of inputs) {
    if (!isValidSkillFilePath(file.path)) {
      return invalid(`File path "${file.path}" is not a relative path inside the skill.`);
    }
    if (seen.has(file.path)) return invalid(`File path "${file.path}" appears more than once.`);
    seen.add(file.path);
  }
  const skillMd = inputs.find((file) => file.path === SKILL_MD_PATH);
  if (!skillMd) return invalid("A skill must contain a SKILL.md file at its root.");
  const parsed = parseSkillMarkdown(skillMd.content);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);

  let total = 0;
  const files: SkillFile[] = [];
  for (const file of [...inputs].sort(compareSkillPaths)) {
    const size = skillContentByteLength(file.content);
    total += size;
    if (total > SKILL_MAX_TOTAL_BYTES) {
      return invalid(`A skill's files can total at most ${SKILL_MAX_TOTAL_BYTES} bytes.`);
    }
    files.push({
      path: file.path,
      content: file.content,
      size,
      digest: await digestSkillContent(file.content),
    });
  }
  return Result.succeed({ parsed: parsed.success, files });
};

// ---------------------------------------------------------------------------
// URIs — the MCP Skills Extension form. `skill://<owner>/<name>/<path>`; the
// final skill-path segment is the name, as the extension requires, and the
// owner is the server-chosen prefix that keeps a personal and a workspace skill
// of the same name distinct.
// ---------------------------------------------------------------------------

export const SKILL_URI_SCHEME = "skill://";

export const skillRootUri = (ref: SkillRef): string =>
  `${SKILL_URI_SCHEME}${ref.owner}/${ref.name}`;

export const skillFileUri = (ref: SkillRef, path: string): string => `${skillRootUri(ref)}/${path}`;

export interface ParsedSkillUri extends SkillRef {
  /** Empty for the skill root directory. */
  readonly path: string;
}

/** Parse `skill://<owner>/<name>[/<path>]` back into its parts, or `None`. */
export const parseSkillUri = (uri: string): Option.Option<ParsedSkillUri> => {
  if (!uri.startsWith(SKILL_URI_SCHEME)) return Option.none();
  const [owner, name, ...pathSegments] = uri.slice(SKILL_URI_SCHEME.length).split("/");
  if ((owner !== "org" && owner !== "user") || name === undefined || !isValidSkillName(name)) {
    return Option.none();
  }
  const path = pathSegments.join("/");
  if (path.length > 0 && !isValidSkillFilePath(path)) return Option.none();
  return Option.some({ owner, name, path });
};

// ---------------------------------------------------------------------------
// Row projections
// ---------------------------------------------------------------------------

// The stored `files` column is decoded through this; it is the same shape as
// `SkillFile`, kept as a schema here because the row is the only place bytes
// arrive untyped.
const StoredSkillFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  size: Schema.Number,
  digest: Schema.String,
});
const decodeFiles = Schema.decodeUnknownOption(Schema.Array(StoredSkillFile));
const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/** JSON arrives as an object on Postgres and as a string on SQLite. */
const jsonFromColumn = (value: unknown): Option.Option<unknown> =>
  typeof value === "string" ? decodeJsonString(value) : Option.some(value);

const filesFromColumn = (value: unknown): readonly SkillFile[] =>
  Option.flatMap(jsonFromColumn(value), decodeFiles).pipe(Option.getOrElse(() => []));

const frontmatterFromColumn = (value: unknown): Readonly<Record<string, unknown>> =>
  Option.filter(jsonFromColumn(value), isRecord).pipe(Option.getOrElse(() => ({})));

const asDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value);

export const rowToSkill = (row: SkillRow): Skill => ({
  owner: row.owner as Owner,
  name: SkillName.make(row.name),
  description: row.description,
  frontmatter: frontmatterFromColumn(row.frontmatter),
  files: filesFromColumn(row.files),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

export const toSkillSummary = (skill: Skill): SkillSummary => ({
  ...skill,
  files: skill.files.map(({ path, size, digest }) => ({ path, size, digest })),
});

/** The markdown body of a stored skill's SKILL.md (frontmatter stripped). */
export const skillBody = (skill: Skill): string => {
  const skillMd = skill.files.find((file) => file.path === SKILL_MD_PATH);
  if (!skillMd) return "";
  const parsed = parseSkillMarkdown(skillMd.content);
  return Result.isSuccess(parsed) ? parsed.success.body : skillMd.content;
};
