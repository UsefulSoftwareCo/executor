/** Durable app source lives in a host-owned revision store, independently of SQL and builds. */
import { Effect, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { ApiError } from "@executor-js/utils/api-error";
import { AppCodeId, type AppId, type OwnerId, type StorageError } from "./shared.ts";
import type { AppNotFound } from "./apps.ts";

/**
 * Canonical relative POSIX path inside a deployment: no absolute paths,
 * backslashes, NUL bytes, or empty/`.`/`..` segments. Plain refined
 * strings — callers need not brand every path.
 */
export const SourceFilePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => {
      if (path.includes("\0")) return "expected no NUL bytes";
      if (path.includes("\\")) return "expected POSIX separators";
      if (path.startsWith("/")) return "expected a relative path";
      return path.length > 0 && path.split("/").every((s) => s !== "" && s !== "." && s !== "..")
        ? true
        : "expected canonical segments (non-empty, no `.` or `..`)";
    }),
  ),
);

export type SourceFilePath = typeof SourceFilePath.Type;

/**
 * Browser files served as they are, at the app page's origin. They are the only source that may
 * hold bytes that are not UTF-8 text: the host never compiles, evaluates or reads them, and builds
 * do not load them. Deploys copy them to the host's own store, from which they are served.
 */
export const publicSourcePrefix = "ui/public/";
/** Whether a source path is a public file under `ui/public/`. */
export const isPublicSourcePath = (path: string) => path.startsWith(publicSourcePrefix);

/** A Git blob's object ID: the SHA-1 of `blob <size>\0` and its bytes. */
export const GitObjectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)).annotate({
  description: "Git blob object ID: 40 lowercase hex characters.",
});
export type GitObjectId = typeof GitObjectId.Type;

/** One UTF-8 text file. Content may be empty. Every file outside `ui/public/` is text. */
export const SourceTextFile = Schema.Struct({ path: SourceFilePath, content: Schema.String });
export type SourceTextFile = typeof SourceTextFile.Type;

/** Standard base64 with padding, as `encoding: "base64"` file contents use. */
const Base64Content = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
);

/** One file's exact bytes, base64-encoded. Only files under `ui/public/` may be binary. */
export const SourceBinaryFile = Schema.Struct({
  path: SourceFilePath,
  content: Base64Content.annotate({ description: "The file's bytes, standard base64." }),
  encoding: Schema.Literal("base64"),
});
export type SourceBinaryFile = typeof SourceBinaryFile.Type;

/**
 * A file under `ui/public/` already in the app's Git repository, named by its blob and not
 * inlined. Reads list a public file this way when it is not UTF-8 text or does not fit beside the
 * rest of the source; sending the entry back in a commit keeps the file unchanged.
 */
export const SourceStoredFile = Schema.Struct({
  path: SourceFilePath,
  object: GitObjectId,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "The file's size in bytes.",
  }),
});
export type SourceStoredFile = typeof SourceStoredFile.Type;

/**
 * One file of app source: UTF-8 text, base64 bytes, or a public file stored in the app's Git
 * repository. Binary and stored files are only allowed under `ui/public/`.
 */
export const SourceFile = Schema.Union([SourceBinaryFile, SourceStoredFile, SourceTextFile]);
export type SourceFile = typeof SourceFile.Type;

/** A text file, the only kind code, manifests and skills can be. */
export const isTextFile = (file: SourceFile): file is SourceTextFile =>
  !("object" in file) && !("encoding" in file);

/**
 * A deployment's complete source: at least one file, unique paths, and a
 * root `index.ts` entrypoint. `package.json` is optional — the host
 * supplies `apps`, and extra dependencies may come from an
 * optional `package.json`. MCP/OpenAPI/GraphQL importers
 * emit ordinary files like these (their remote discovery still runs live at
 * evaluation); they are not special execution paths.
 */
export const SourceFiles = Schema.NonEmptyArray(SourceFile).pipe(
  Schema.check(
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      new Set(files.map((f) => f.path)).size === files.length ? true : "expected unique paths",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      files.some((f) => f.path === "index.ts") ? true : "expected a root index.ts",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) => {
      const misplaced = files.find((file) => !isTextFile(file) && !isPublicSourcePath(file.path));
      return misplaced === undefined
        ? true
        : `expected ${misplaced.path} to be UTF-8 text: only files under ${publicSourcePrefix} may be binary or stored`;
    }),
  ),
);

export type SourceFiles = typeof SourceFiles.Type;

/** The text files the build compiles and the host reads: every file outside `ui/public/`. */
export const CodeFiles = Schema.NonEmptyArray(SourceTextFile).pipe(
  Schema.check(
    Schema.makeFilter((files: ReadonlyArray<SourceTextFile>) =>
      new Set(files.map((f) => f.path)).size === files.length ? true : "expected unique paths",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceTextFile>) =>
      files.some((f) => f.path === "index.ts") ? true : "expected a root index.ts",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceTextFile>) =>
      files.every((file) => !isPublicSourcePath(file.path))
        ? true
        : `expected no files under ${publicSourcePrefix}`,
    ),
  ),
);
export type CodeFiles = typeof CodeFiles.Type;

/** Split source into the code a build loads and the public files it serves as they are. */
export const splitSource = (files: SourceFiles) => {
  const code: SourceTextFile[] = [];
  const served: SourceFile[] = [];
  for (const file of files) {
    if (isPublicSourcePath(file.path)) served.push(file);
    // SourceFiles admits only text outside ui/public/.
    else if (isTextFile(file)) code.push(file);
  }
  return { code, public: served };
};

/** The text of one source file, or undefined when it is absent or not text. */
export const sourceText = (files: ReadonlyArray<SourceFile>, path: string) => {
  const file = files.find((candidate) => candidate.path === path);
  return file !== undefined && isTextFile(file) ? file.content : undefined;
};

/** What identifies one file's contents: its text, its base64 bytes or its stored blob. */
const fileIdentity = (file: SourceFile) =>
  "object" in file
    ? `object:${file.object}`
    : "encoding" in file
      ? `base64:${file.content}`
      : `text:${file.content}`;

/** File order is presentation; path and contents define source identity. */
export const sourceFilesEqual = (
  left: ReadonlyArray<SourceFile>,
  right: ReadonlyArray<SourceFile>,
): boolean => {
  if (left.length !== right.length) return false;
  const contents = new Map(left.map((file) => [file.path, fileIdentity(file)]));
  return right.every((file) => contents.get(file.path) === fileIdentity(file));
};

/** Bytes of a base64 file. The schema has already checked the alphabet and padding. */
export const decodeBase64 = (content: string) =>
  Result.getOrElse(Base64.decode(content), () => new Uint8Array());
/** Standard padded base64 of bytes. */
export const encodeBase64 = (bytes: Uint8Array) => Base64.encode(bytes);

/** The size in bytes of one file's contents. */
export const sourceFileBytes = (file: SourceFile) =>
  "object" in file
    ? file.size
    : "encoding" in file
      ? Math.floor((file.content.length * 3) / 4) -
        (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0)
      : new TextEncoder().encode(file.content).length;

/** The bytes of an inline file: its UTF-8 text or its decoded base64. */
export const inlineBytes = (file: SourceTextFile | SourceBinaryFile) =>
  "encoding" in file ? decodeBase64(file.content) : new TextEncoder().encode(file.content);

/** A Git blob's object ID for these bytes. */
export const gitBlobId = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const object = new Uint8Array(header.length + bytes.length);
    object.set(header);
    object.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", object);
    return GitObjectId.make(
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
  });

/** A full immutable Git commit, never a mutable branch name. */
export const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
/** Source references keep the code lineage explicit so revisions cannot cross repositories. */
export const SourceRevision = Schema.Struct({ code: AppCodeId, commit: SourceCommit });
export type SourceRevision = typeof SourceRevision.Type;

/** Editable app source at one confirmed Git revision. */
export const SourceSnapshot = Schema.Struct({ revision: SourceRevision, files: SourceFiles });
export type SourceSnapshot = typeof SourceSnapshot.Type;

/**
 * The listed removals stay small beside the revision, however many files a save drops: `bytes`
 * bounds the encoded JSON of `paths`, so the whole result stays far below an execute result.
 */
export const removalLimits = { paths: 100, bytes: 16 * 1024 } as const;

/** What a save removed: the total and the first paths, bounded so the result is never cut off. */
export const SourceRemovals = Schema.Struct({
  count: Schema.Int.annotate({
    description: "How many files of the `expected` revision this save removed. 0 when none.",
  }),
  paths: Schema.Array(SourceFilePath).annotate({
    description:
      "The first removed paths, sorted: at most 100, fewer when they are long. When `count` is larger, the rest are the paths of the files you read at `expected` that you did not send. The removed files stay readable at `expected`.",
  }),
});
export type SourceRemovals = typeof SourceRemovals.Type;

/**
 * A saved commit. The caller already holds the files it sent, so they are not echoed back.
 * A save replaces the complete file list, so it names the files the previous revision had that
 * the new one does not; a commit does not deploy, so an unintended removal shows before it runs.
 */
export const CommittedSource = Schema.Struct({ revision: SourceRevision, removed: SourceRemovals });
export type CommittedSource = typeof CommittedSource.Type;

const sourceFailures = {
  "not-found": "The requested app source revision does not exist.",
  conflict:
    "The app's source changed since it was read. Read the latest source, reapply the change, then commit against the new revision.",
  "invalid-source":
    "The app source is not valid: files outside ui/public/ must be UTF-8 text, paths and file modes must be supported, and stored files must name blobs of the revision they were read from.",
  git: "Executor's Git storage could not complete this source operation. Try again.",
  storage: "Executor could not read or write this app's source. Try again.",
  limit:
    "The app source exceeds Executor's limits: at most 4,096 code files and 16 MiB of code and inline files, and at most 10,000 public files under ui/public/, each at most 32 MB and 1 GB in total.",
  protected:
    "The app's Git history is protected from this change, such as deleting or recreating its main branch, or an unsupported push format.",
} as const;
/** Safe source failures; command output and remote credentials remain inside adapters. */
export const SourceError = ApiError.define({
  tag: "SourceError",
  status: 500,
  fields: {
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "invalid-source",
      "git",
      "storage",
      "limit",
      "protected",
    ]),
  },
  message: ({ reason }) => sourceFailures[reason],
  recorded: ({ reason }) => sourceFailures[reason],
});
export type SourceError = typeof SourceError.Type;

/**
 * Git stores a path as either a file or a folder, so a file list that has both `a` and `a/b`
 * would silently lose one of them. Saves refuse it, naming the file and a path inside it.
 */
export const SourcePathConflict = ApiError.define({
  tag: "SourcePathConflict",
  status: 400,
  fields: { file: SourceFilePath, nested: SourceFilePath },
  message: ({ file, nested }) =>
    `The files use ${file} as both a file and a folder: ${nested} is inside it. Git can store only one of them. Rename or remove one, then save again. Nothing was saved.`,
  recorded: () => "The files use one path as both a file and a folder. Nothing was saved.",
});
export type SourcePathConflict = typeof SourcePathConflict.Type;

/**
 * Git stores paths as UTF-8, which cannot hold a lone UTF-16 surrogate: encoding replaces it
 * with U+FFFD, so two paths that differ here could become one file. Saves refuse it.
 */
export const SourcePathNotUnicode = ApiError.define({
  tag: "SourcePathNotUnicode",
  status: 400,
  fields: { path: SourceFilePath },
  message: ({ path }) =>
    `The file path ${JSON.stringify(path)} is not valid Unicode: it has a lone surrogate, a \\uD800-\\uDFFF character without its pair. Git stores paths as UTF-8, which cannot hold it. Rename the file, then save again. Nothing was saved.`,
  recorded: () => "A file path is not valid Unicode. Nothing was saved.",
});
export type SourcePathNotUnicode = typeof SourcePathNotUnicode.Type;

/**
 * Refuse a file list whose paths would not each be one distinct Git path: a path that is not
 * valid Unicode, or a file's path that is also a folder of another file.
 */
export const sourcePathsFit = (files: ReadonlyArray<SourceFile>) => {
  // With the `u` flag, a surrogate pair is one code point, so this matches only a lone surrogate.
  const lone = files.find((file) => /\p{Cs}/u.test(file.path));
  if (lone !== undefined) return Effect.fail(new SourcePathNotUnicode({ path: lone.path }));
  const paths = new Set(files.map((file) => file.path));
  for (const nested of [...paths].sort()) {
    const segments = nested.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const file = segments.slice(0, depth).join("/");
      if (paths.has(file)) return Effect.fail(new SourcePathConflict({ file, nested }));
    }
  }
  return Effect.void;
};

/** Transport status follows the failure reason while preserving the SourceError domain value. */
export const sourceErrors = [
  SourceError.check(Schema.makeFilter((error) => error.reason === "conflict")).annotate({
    identifier: "SourceConflict",
    httpApiStatus: 409,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "not-found")).annotate({
    identifier: "SourceMissing",
    httpApiStatus: 404,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "protected")).annotate({
    identifier: "SourceProtected",
    httpApiStatus: 403,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "invalid-source")).annotate({
    identifier: "SourceInvalid",
    httpApiStatus: 400,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "limit")).annotate({
    identifier: "SourceLimit",
    httpApiStatus: 413,
  }),
  SourceError.check(
    Schema.makeFilter((error) => error.reason === "git" || error.reason === "storage"),
  ).annotate({ identifier: "SourceUnavailable", httpApiStatus: 503 }),
  SourcePathNotUnicode,
  SourcePathConflict,
] as const;

/** Count the previous revision's paths that a complete file list leaves out, and list the first. */
export const removedPaths = (
  previous: Iterable<string>,
  files: ReadonlyArray<SourceFile>,
): SourceRemovals => {
  const kept = new Set(files.map((file) => file.path));
  const removed = [...previous].filter((path) => !kept.has(path)).sort();
  const paths: string[] = [];
  // Measure the JSON the list is sent as, where an escaped character can take six bytes.
  let bytes = "[]".length;
  for (const path of removed.slice(0, removalLimits.paths)) {
    bytes += new TextEncoder().encode(JSON.stringify(path)).length + (paths.length > 0 ? 1 : 0);
    if (bytes > removalLimits.bytes) break;
    paths.push(path);
  }
  return { count: removed.length, paths };
};

/** Hosts must retain successful writes while any deployment or release references them. */
export interface AppSourceStorage {
  /** Pin one commit's files under a protected branch. Stored files are blobs of `basis`. */
  readonly retain: (
    code: AppCodeId,
    files: SourceFiles,
    basis: SourceRevision["commit"],
  ) => Effect.Effect<SourceRevision, SourceError>;
  readonly read: (revision: SourceRevision) => Effect.Effect<SourceFiles, SourceError>;
  readonly workspace: (code: AppCodeId) => Effect.Effect<SourceSnapshot | null, SourceError>;
  readonly commit: (input: {
    readonly code: AppCodeId;
    readonly expected: string | null;
    readonly files: ReadonlyArray<CommitFile>;
    readonly message: string;
  }) => Effect.Effect<
    Pick<SourceSnapshot, "revision"> & Pick<CommittedSource, "removed">,
    SourceError
  >;
  /** One blob of the code's repository, such as a public file a read listed by its object. */
  readonly blob: (code: AppCodeId, object: GitObjectId) => Effect.Effect<Uint8Array, SourceError>;
  /** One file of a revision by path; a missing file is not-found. */
  readonly file: (revision: SourceRevision, path: string) => Effect.Effect<Uint8Array, SourceError>;
}

/** Portable branch names, including the private retention prefix used by the source service. */
export const Branch = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9/_-]{0,127}$/u),
  Schema.makeFilter((value) => !value.endsWith("/") && !value.includes("//")),
);
/**
 * What one source operation holds in memory, identical for complete writes and incremental reads
 * on every host: every code file (outside `ui/public/`) and any public file it carries inline.
 * Saves, builds and deploys hold these in a Worker's 128 MB, so they stay bounded. Public files a
 * read lists by their blob (`SourceStoredFile`) are not held and do not count here.
 */
export const sourceLimits = { files: 4096, bytes: 16 * 1024 * 1024 } as const;
/**
 * Public files under `ui/public/`, which builds never load and deploys copy one at a time:
 *
 * - `fileBytes`: Cloudflare Artifacts, which stores hosted app source, refuses a file over 32 MB.
 * - `bytes`: an Artifacts repository holds at most 1 GB, so no commit's files can exceed it.
 * - `files`: each deployment lists its public files in one object read when they are served, and
 *   each file is a few storage operations at deploy; 10,000 keeps both small.
 */
export const publicFileLimits = {
  files: 10_000,
  fileBytes: 32_000_000,
  bytes: 1_000_000_000,
} as const;
/** Reject invalid counters and stop readers before they accumulate an oversized source tree. */
export const sourceFits = (files: number, bytes: number): boolean =>
  Number.isSafeInteger(files) &&
  files >= 0 &&
  files <= sourceLimits.files &&
  Number.isSafeInteger(bytes) &&
  bytes >= 0 &&
  bytes <= sourceLimits.bytes;
/** Whether public files of these counts fit, each at most `fileBytes`. */
export const publicFits = (files: number, bytes: number, largest: number): boolean =>
  Number.isSafeInteger(files) &&
  files >= 0 &&
  files <= publicFileLimits.files &&
  Number.isSafeInteger(bytes) &&
  bytes >= 0 &&
  bytes <= publicFileLimits.bytes &&
  largest <= publicFileLimits.fileBytes;
/** Recent source history is metadata, separate from the files at each immutable revision. */
export const GitCommit = Schema.Struct({
  commit: SourceCommit,
  author: Schema.String,
  message: Schema.String,
  timestamp: Schema.Int,
});
export type GitCommit = typeof GitCommit.Type;
/**
 * Bounded source: code and inline public bytes within `sourceLimits`, public files within
 * `publicFileLimits`. Generated dependency paths are legal in retained deployment snapshots.
 */
export const sourceFiles = <F extends ReadonlyArray<SourceFile>>(files: F) => {
  let codeFiles = 0;
  let held = 0;
  let publicFiles = 0;
  let publicBytes = 0;
  let largest = 0;
  for (const file of files) {
    const size = sourceFileBytes(file);
    if (!("object" in file)) held += size;
    if (isPublicSourcePath(file.path)) {
      publicFiles += 1;
      publicBytes += size;
      largest = Math.max(largest, size);
    } else codeFiles += 1;
  }
  return sourceFits(codeFiles, held) && publicFits(publicFiles, publicBytes, largest)
    ? Effect.succeed(files)
    : Effect.fail(new SourceError({ reason: "limit" }));
};

/**
 * A public file's bytes from outside the repository, written into it by a save: a copy's files
 * from another app, or files a host retained before the repository existed. Read one at a time.
 */
export interface SourceUpload {
  readonly path: string;
  readonly object: GitObjectId;
  readonly size: number;
  readonly read: Effect.Effect<Uint8Array, SourceError>;
}

/** What a save writes: source files, plus public files whose bytes come from elsewhere. */
export type CommitFile = SourceFile | SourceUpload;
/** Whether a save file carries its own bytes from outside the repository. */
export const isUpload = (file: CommitFile): file is SourceUpload => "read" in file;

/**
 * The Git backend a host supplies to `createExecutor`. Platform mechanics only: app ownership
 * and public package names never reach it. The executor derives its source storage from it.
 */
export interface RepositoryBackend {
  readonly history: (id: AppCodeId) => Effect.Effect<ReadonlyArray<GitCommit>, SourceError>;
  readonly create: (id: AppCodeId) => Effect.Effect<void, SourceError>;
  readonly head: (id: AppCodeId, branch: string) => Effect.Effect<string | null, SourceError>;
  /**
   * Read one coherent snapshot; an absent branch fails with not-found, never another branch's
   * files. Code files are text. A public file under `ui/public/` is inline text when it is UTF-8
   * and fits within `sourceLimits` beside the code and the public files before it in path order;
   * otherwise it is listed by its blob as a `SourceStoredFile`, without reading it into memory.
   */
  readonly read: (
    id: AppCodeId,
    ref: string,
  ) => Effect.Effect<{ readonly commit: string; readonly files: SourceFiles }, SourceError>;
  /**
   * Create the repository for an initial write; existing writes must match the supplied revision.
   * Returns the new commit and the paths of the expected revision that the files leave out.
   */
  readonly commit: (input: {
    readonly id: AppCodeId;
    readonly branch: string;
    readonly expected: string | null;
    /**
     * Inline files are written as given; uploads are read one at a time and written. A stored
     * file must name a blob of `basis` (by default `expected`); anything else is invalid source.
     */
    readonly files: ReadonlyArray<CommitFile>;
    readonly basis?: string | undefined;
    readonly message: string;
  }) => Effect.Effect<
    { readonly commit: typeof SourceCommit.Type; readonly removed: SourceRemovals },
    SourceError
  >;
  /** One blob's bytes, at most `publicFileLimits.fileBytes`; a missing blob is not-found. */
  readonly blob: (id: AppCodeId, object: GitObjectId) => Effect.Effect<Uint8Array, SourceError>;
  /** One file of a commit by its path; a missing path is not-found. */
  readonly file: (
    id: AppCodeId,
    commit: typeof SourceCommit.Type,
    path: string,
  ) => Effect.Effect<Uint8Array, SourceError>;
  /** Serve one Git smart-HTTP request against the repository. */
  readonly request: (id: AppCodeId, request: Request) => Effect.Effect<Response, SourceError>;
}

/** Git protocol access is host-only, outside the public HTTP/Promise facade. */
export const RepositoryHost = Symbol("executor.RepositoryHost");
/** Hosts authorize the caller and then hand the raw Git request to the app's repository. */
export interface RepositoryHost {
  readonly request: (
    input: { readonly app: AppId; readonly owner?: OwnerId | undefined },
    request: Request,
  ) => Effect.Effect<Response, SourceError | AppNotFound | StorageError>;
  /** Retry pending repository creation with bounded parallel work. */
  readonly recover: Effect.Effect<void, StorageError>;
}
