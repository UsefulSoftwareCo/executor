/** Prefix for static files that hosts serve without compiling. */
export const publicSourcePrefix = "ui/public/";
/** Whether a path names a static public file. */
export const isPublicSourcePath = (path: string) => path.startsWith(publicSourcePrefix);

/** Code files stay within the amount every host can hold while saving and building. */
export const sourceLimits = { files: 4096, bytes: 16 * 1024 * 1024 } as const;
/** Public assets are served as-is and have their own storage limits. */
export const publicFileLimits = {
  files: 10_000,
  fileBytes: 32_000_000,
  bytes: 1_000_000_000,
} as const;

export const sourceFits = (files: number, bytes: number): boolean =>
  Number.isSafeInteger(files) &&
  files >= 0 &&
  files <= sourceLimits.files &&
  Number.isSafeInteger(bytes) &&
  bytes >= 0 &&
  bytes <= sourceLimits.bytes;

export const publicFits = (files: number, bytes: number, largest: number): boolean =>
  Number.isSafeInteger(files) &&
  files >= 0 &&
  files <= publicFileLimits.files &&
  Number.isSafeInteger(bytes) &&
  bytes >= 0 &&
  bytes <= publicFileLimits.bytes &&
  largest <= publicFileLimits.fileBytes;

/** The path rules shared with the host's SourceFilePath schema. */
export const sourcePathProblem = (path: string): string | undefined => {
  if (path.includes("\0")) return "expected no NUL bytes";
  if (path.includes("\\")) return "expected POSIX separators";
  if (path.startsWith("/")) return "expected a relative path";
  return path.length > 0 &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    ? undefined
    : "expected canonical segments (non-empty, no `.` or `..`)";
};

export type AppCheckFile = {
  readonly path: string;
  /** Code and manifests carry their exact text or bytes. Public files may use only `size`. */
  readonly content?: string | Uint8Array;
  readonly size?: number;
};

export type AppCheckIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const exactVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);

const contentBytes = (content: string | Uint8Array) =>
  typeof content === "string" ? encoder.encode(content).byteLength : content.byteLength;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Check the manifest and files without comparing an exact `apps` pin with a host release. */
export function checkApp(files: readonly AppCheckFile[]): AppCheckIssue[] {
  const issues: AppCheckIssue[] = [];
  const paths = new Set<string>();
  let codeFiles = 0;
  let publicFiles = 0;
  const publicSizes: number[] = [];
  let codeBytes = 0;
  let publicBytes = 0;

  for (const file of files) {
    const pathProblem = sourcePathProblem(file.path);
    if (pathProblem !== undefined) {
      issues.push({ code: "source-path", message: pathProblem, path: file.path });
      continue;
    }
    if (paths.has(file.path)) {
      issues.push({ code: "source-path", message: "duplicate path", path: file.path });
      continue;
    }
    paths.add(file.path);

    if (isPublicSourcePath(file.path)) {
      publicFiles++;
      const size = file.content === undefined ? file.size : contentBytes(file.content);
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
        issues.push({
          code: "public-file-size",
          message: "file size must be a non-negative integer",
          path: file.path,
        });
        continue;
      }
      publicSizes.push(size);
      publicBytes += size;
      if (size > publicFileLimits.fileBytes)
        issues.push({ code: "public-file-size", message: "file exceeds 32 MB", path: file.path });
      continue;
    }

    codeFiles++;
    if (file.content === undefined) {
      issues.push({
        code: "source-utf8",
        message: "must be UTF-8 text outside ui/public/",
        path: file.path,
      });
      continue;
    }
    if (file.content instanceof Uint8Array) {
      try {
        decoder.decode(file.content);
      } catch {
        issues.push({
          code: "source-utf8",
          message: "must be UTF-8 text outside ui/public/",
          path: file.path,
        });
        continue;
      }
    }
    const size = contentBytes(file.content);
    codeBytes += size;
  }

  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length > 0) {
      const parent = segments.join("/");
      if (paths.has(parent)) {
        issues.push({
          code: "source-path",
          message: "a file cannot also be a parent directory",
          path,
        });
        break;
      }
      segments.pop();
    }
  }

  if (!paths.has("index.ts"))
    issues.push({ code: "default-app-export", message: "missing index.ts", path: "index.ts" });

  if (!sourceFits(codeFiles, codeBytes)) {
    if (codeFiles > sourceLimits.files)
      issues.push({ code: "source-file-count", message: "exceeds 4096 files" });
    if (codeBytes > sourceLimits.bytes)
      issues.push({ code: "source-size", message: "exceeds 16 MiB" });
  }

  const largestPublic = publicSizes.reduce((largest, size) => Math.max(largest, size), 0);
  if (!publicFits(publicFiles, publicBytes, largestPublic)) {
    if (publicFiles > publicFileLimits.files)
      issues.push({ code: "public-file-count", message: "exceeds 10000 files" });
    if (publicBytes > publicFileLimits.bytes)
      issues.push({ code: "public-total-size", message: "exceeds 1 GB" });
    if (
      largestPublic > publicFileLimits.fileBytes &&
      !issues.some((issue) => issue.code === "public-file-size")
    )
      issues.push({ code: "public-file-size", message: "a file exceeds 32 MB" });
  }

  const manifestFile = files.find((file) => file.path === "package.json");
  if (manifestFile?.content === undefined) {
    issues.push({
      code: "manifest-module",
      message: "package.json is required",
      path: "package.json",
    });
  } else {
    let manifestText: string;
    try {
      manifestText =
        typeof manifestFile.content === "string"
          ? manifestFile.content
          : decoder.decode(manifestFile.content);
    } catch {
      issues.push({
        code: "manifest-module",
        message: "package.json must be UTF-8 text",
        path: "package.json",
      });
      return issues;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      issues.push({
        code: "manifest-module",
        message: "package.json must contain valid JSON",
        path: "package.json",
      });
      return issues;
    }
    if (!isRecord(manifest) || manifest.type !== "module")
      issues.push({
        code: "manifest-module",
        message: "package.json must set type to module",
        path: "package.json",
      });
    const dependencies =
      isRecord(manifest) && isRecord(manifest.dependencies) ? manifest.dependencies : {};
    if (!exactVersion(dependencies.apps))
      issues.push({
        code: "framework-pin",
        message: "dependencies.apps must be an exact version",
        path: "package.json",
      });
  }

  return issues;
}
