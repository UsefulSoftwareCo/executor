import { Effect, Encoding, Option, Result, Schema } from "effect";
import { parse as parseYaml } from "yaml";

import { SkillPackageDigest, SkillName } from "./ids";

export const SKILL_MD_PATH = "SKILL.md";
export const SKILL_MAX_FILES = 64;
export const SKILL_MAX_FILE_BYTES = 512 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
export const SKILL_MAX_PATH_BYTES = 512;
export const SKILL_MAX_PATH_SEGMENTS = 32;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const URI_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

export interface SkillPackageFileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export const SkillDiagnosticSeverity = Schema.Literals(["warning", "blocking"]);
export type SkillDiagnosticSeverity = typeof SkillDiagnosticSeverity.Type;

export const SkillDiagnostic = Schema.Struct({
  severity: SkillDiagnosticSeverity,
  code: Schema.String,
  message: Schema.String,
  path: Schema.NullOr(Schema.String),
});
export type SkillDiagnostic = typeof SkillDiagnostic.Type;

export const SkillPackageManifestFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  digest: Schema.String,
  mediaType: Schema.String,
  encoding: Schema.Literal("base64"),
});
export type SkillPackageManifestFile = typeof SkillPackageManifestFile.Type;

export interface PreparedSkillFile extends SkillPackageManifestFile {
  readonly encodedBytes: string;
}

export interface PreparedSkillRevision {
  readonly packageDigest: SkillPackageDigest;
  readonly name: SkillName | null;
  readonly description: string | null;
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly files: readonly PreparedSkillFile[];
  readonly diagnostics: readonly SkillDiagnostic[];
}

export type PreparedSkillPackage =
  | {
      readonly kind: "rejected";
      readonly diagnostics: readonly [SkillDiagnostic, ...SkillDiagnostic[]];
    }
  | { readonly kind: "blocked"; readonly revision: PreparedSkillRevision }
  | { readonly kind: "valid"; readonly revision: PreparedSkillRevision };

export class SkillPackageFileNotFoundError extends Schema.TaggedErrorClass<SkillPackageFileNotFoundError>()(
  "SkillPackageFileNotFoundError",
  { path: Schema.String },
) {}

export class SkillPackageCorruptError extends Schema.TaggedErrorClass<SkillPackageCorruptError>()(
  "SkillPackageCorruptError",
  { path: Schema.String, reason: Schema.String },
) {}

const diagnostic = (
  severity: SkillDiagnosticSeverity,
  code: string,
  message: string,
  path: string | null = null,
): SkillDiagnostic => ({ severity, code, message, path });

const rejected = (code: string, message: string, path: string | null = null) =>
  ({
    kind: "rejected",
    diagnostics: [diagnostic("blocking", code, message, path)],
  }) satisfies PreparedSkillPackage;

export const isValidSkillName = (name: string): boolean =>
  name.length >= 1 && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);

export const defaultSkillInvocation = (
  frontmatter: Readonly<Record<string, unknown>> | null,
): "manual" | "model" => (frontmatter?.["disable-model-invocation"] === true ? "manual" : "model");

export const isSafeSkillFilePath = (path: string): boolean => {
  if (path.length === 0 || encoder.encode(path).byteLength > SKILL_MAX_PATH_BYTES) return false;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacter(path) ||
    DRIVE_PREFIX.test(path) ||
    URI_PREFIX.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments.length <= SKILL_MAX_PATH_SEGMENTS &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
};

const mediaTypeFor = (path: string, supplied: string | undefined): string => {
  if (supplied !== undefined && supplied.trim() !== "") return supplied;
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
};

const digestBytes = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () => {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", input.buffer);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  });

const decodeUtf8 = (bytes: Uint8Array): Result.Result<string, void> =>
  Result.try({
    try: () => strictDecoder.decode(bytes),
    catch: () => undefined,
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface FrontmatterBlock {
  readonly yaml: string;
}

const splitFrontmatter = (markdown: string): Option.Option<FrontmatterBlock> => {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return Option.none();
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return closing === -1 ? Option.none() : Option.some({ yaml: lines.slice(1, closing).join("\n") });
};

interface FrontmatterProjection {
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly name: SkillName | null;
  readonly description: string | null;
  readonly diagnostics: readonly SkillDiagnostic[];
}

const parseFrontmatter = (bytes: Uint8Array): Effect.Effect<FrontmatterProjection> =>
  Effect.sync(() => {
    const decoded = decodeUtf8(bytes);
    if (Result.isFailure(decoded)) {
      return {
        frontmatter: null,
        name: null,
        description: null,
        diagnostics: [
          diagnostic(
            "blocking",
            "skill_markdown_invalid_utf8",
            "SKILL.md must use UTF-8 encoding.",
            SKILL_MD_PATH,
          ),
        ],
      };
    }

    const split = splitFrontmatter(decoded.success);
    if (Option.isNone(split)) {
      return {
        frontmatter: null,
        name: null,
        description: null,
        diagnostics: [
          diagnostic(
            "blocking",
            "frontmatter_missing",
            "SKILL.md must start with YAML frontmatter between `---` lines.",
            SKILL_MD_PATH,
          ),
        ],
      };
    }

    const parsedResult = Result.try({
      try: (): unknown =>
        parseYaml(split.value.yaml, {
          maxAliasCount: 50,
          schema: "core",
          uniqueKeys: true,
        }),
      catch: () => undefined,
    });
    if (Result.isFailure(parsedResult) || !isRecord(parsedResult.success)) {
      return {
        frontmatter: null,
        name: null,
        description: null,
        diagnostics: [
          diagnostic(
            "blocking",
            "frontmatter_invalid_yaml",
            "SKILL.md frontmatter must be a valid YAML mapping.",
            SKILL_MD_PATH,
          ),
        ],
      };
    }
    const parsed = parsedResult.success;

    const diagnostics: SkillDiagnostic[] = [];
    const rawName = parsed.name;
    const name =
      typeof rawName === "string" && isValidSkillName(rawName) ? SkillName.make(rawName) : null;
    if (name === null) {
      diagnostics.push(
        diagnostic(
          "blocking",
          "name_invalid",
          "Frontmatter `name` must contain 1 to 64 lowercase letters, digits, or single hyphens.",
          SKILL_MD_PATH,
        ),
      );
    }

    const rawDescription = parsed.description;
    const description =
      typeof rawDescription === "string" &&
      rawDescription.trim() !== "" &&
      rawDescription.length <= SKILL_DESCRIPTION_MAX_LENGTH
        ? rawDescription.trim()
        : null;
    if (description === null) {
      diagnostics.push(
        diagnostic(
          "blocking",
          "description_invalid",
          `Frontmatter \`description\` must contain 1 to ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`,
          SKILL_MD_PATH,
        ),
      );
    }

    if (
      "compatibility" in parsed &&
      (typeof parsed.compatibility !== "string" ||
        parsed.compatibility.length === 0 ||
        parsed.compatibility.length > SKILL_COMPATIBILITY_MAX_LENGTH)
    ) {
      diagnostics.push(
        diagnostic(
          "blocking",
          "compatibility_invalid",
          `Frontmatter \`compatibility\` must contain 1 to ${SKILL_COMPATIBILITY_MAX_LENGTH} characters.`,
          SKILL_MD_PATH,
        ),
      );
    }
    if ("license" in parsed && typeof parsed.license !== "string") {
      diagnostics.push(
        diagnostic(
          "blocking",
          "license_invalid",
          "Frontmatter `license` must be a string.",
          SKILL_MD_PATH,
        ),
      );
    }
    if ("allowed-tools" in parsed && typeof parsed["allowed-tools"] !== "string") {
      diagnostics.push(
        diagnostic(
          "blocking",
          "allowed_tools_invalid",
          "Frontmatter `allowed-tools` must be a string.",
          SKILL_MD_PATH,
        ),
      );
    }
    if (
      "disable-model-invocation" in parsed &&
      typeof parsed["disable-model-invocation"] !== "boolean"
    ) {
      diagnostics.push(
        diagnostic(
          "blocking",
          "disable_model_invocation_invalid",
          "Frontmatter `disable-model-invocation` must be a boolean.",
          SKILL_MD_PATH,
        ),
      );
    }
    if (
      "metadata" in parsed &&
      (!isRecord(parsed.metadata) ||
        Object.values(parsed.metadata).some((value) => typeof value !== "string"))
    ) {
      diagnostics.push(
        diagnostic(
          "blocking",
          "metadata_invalid",
          "Frontmatter `metadata` must map string keys to string values.",
          SKILL_MD_PATH,
        ),
      );
    }

    return { frontmatter: parsed, name, description, diagnostics };
  });

const comparePaths = (left: SkillPackageFileInput, right: SkillPackageFileInput): number =>
  left.path === SKILL_MD_PATH
    ? -1
    : right.path === SKILL_MD_PATH
      ? 1
      : left.path.localeCompare(right.path);

const portablePathKey = (path: string): string => path.normalize("NFC").toLocaleLowerCase("en-US");

export const prepareSkillPackage = (
  inputs: readonly SkillPackageFileInput[],
): Effect.Effect<PreparedSkillPackage> =>
  Effect.gen(function* () {
    if (inputs.length === 0) return rejected("package_empty", "A skill package has no files.");
    if (inputs.length > SKILL_MAX_FILES) {
      return rejected(
        "package_too_many_files",
        `A skill package can contain at most ${SKILL_MAX_FILES} files.`,
      );
    }

    const exactPaths = new Set<string>();
    const portablePaths = new Map<string, string>();
    const diagnostics: SkillDiagnostic[] = [];
    let totalBytes = 0;

    for (const input of inputs) {
      if (!isSafeSkillFilePath(input.path)) {
        return rejected(
          "path_unsafe",
          `File path "${input.path}" is not a safe relative POSIX path.`,
          input.path,
        );
      }
      if (exactPaths.has(input.path)) {
        return rejected(
          "path_duplicate",
          `File path "${input.path}" appears more than once.`,
          input.path,
        );
      }
      exactPaths.add(input.path);
      if (input.bytes.byteLength > SKILL_MAX_FILE_BYTES) {
        return rejected(
          "file_too_large",
          `File "${input.path}" exceeds the ${SKILL_MAX_FILE_BYTES} byte limit.`,
          input.path,
        );
      }
      totalBytes += input.bytes.byteLength;
      if (totalBytes > SKILL_MAX_TOTAL_BYTES) {
        return rejected(
          "package_too_large",
          `The package exceeds the ${SKILL_MAX_TOTAL_BYTES} byte limit.`,
        );
      }

      const portableKey = portablePathKey(input.path);
      const priorPath = portablePaths.get(portableKey);
      if (priorPath !== undefined && priorPath !== input.path) {
        diagnostics.push(
          diagnostic(
            "blocking",
            "path_portability_collision",
            `Paths "${priorPath}" and "${input.path}" collide on common native filesystems.`,
            input.path,
          ),
        );
      } else {
        portablePaths.set(portableKey, input.path);
      }
    }

    const skillMarkdown = inputs.find((input) => input.path === SKILL_MD_PATH);
    if (skillMarkdown === undefined) {
      return rejected("skill_markdown_missing", "A skill package must contain root SKILL.md.");
    }

    const frontmatter = yield* parseFrontmatter(skillMarkdown.bytes);
    diagnostics.push(...frontmatter.diagnostics);

    const files: PreparedSkillFile[] = [];
    for (const input of [...inputs].sort(comparePaths)) {
      files.push({
        path: input.path,
        size: input.bytes.byteLength,
        digest: yield* digestBytes(input.bytes),
        mediaType: mediaTypeFor(input.path, input.mediaType),
        encoding: "base64",
        encodedBytes: Encoding.encodeBase64(input.bytes),
      });
    }

    const packageDigest = SkillPackageDigest.make(
      yield* digestBytes(
        encoder.encode(
          JSON.stringify(files.map(({ path, size, digest }) => ({ path, size, digest }))),
        ),
      ),
    );
    const revision: PreparedSkillRevision = {
      packageDigest,
      name: frontmatter.name,
      description: frontmatter.description,
      frontmatter: frontmatter.frontmatter,
      files,
      diagnostics,
    };
    return diagnostics.some(({ severity }) => severity === "blocking")
      ? { kind: "blocked", revision }
      : { kind: "valid", revision };
  });

export const readPreparedSkillFile = (
  revision: PreparedSkillRevision,
  path: string,
): Effect.Effect<Uint8Array, SkillPackageFileNotFoundError | SkillPackageCorruptError> =>
  Effect.gen(function* () {
    const file = revision.files.find((candidate) => candidate.path === path);
    if (file === undefined) return yield* new SkillPackageFileNotFoundError({ path });
    const decoded = Encoding.decodeBase64(file.encodedBytes);
    if (Result.isFailure(decoded)) {
      return yield* new SkillPackageCorruptError({ path, reason: "Stored base64 is invalid." });
    }
    if (decoded.success.byteLength !== file.size) {
      return yield* new SkillPackageCorruptError({ path, reason: "Stored size does not match." });
    }
    const digest = yield* digestBytes(decoded.success);
    if (digest !== file.digest) {
      return yield* new SkillPackageCorruptError({ path, reason: "Stored digest does not match." });
    }
    return decoded.success;
  });
