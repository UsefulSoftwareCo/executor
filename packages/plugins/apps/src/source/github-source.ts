import { Data, Effect, Result } from "effect";

import { PublishError, type FileDiagnostic } from "../pipeline/discover";
import { PUBLISH_LIMITS, enforcePublishLimits } from "../pipeline/publish";
import type { AppSourceRef } from "../pipeline/descriptor";
import type { AppsRuntime } from "../plugin/runtime";
import type { FileSet, SnapshotId } from "../seams/artifact-store";

export interface GitHubSourceInput {
  readonly repo: string;
  readonly ref?: string;
  readonly token?: string | null;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface GitHubSourceSnapshot {
  readonly files: FileSet;
  readonly repo: string;
  readonly ref: string;
  readonly upstreamSha: string;
  readonly description?: string;
  readonly skipped: readonly GitHubSkippedArtifact[];
}

export class GitHubSourceError extends Data.TaggedError("GitHubSourceError")<{
  readonly message: string;
  readonly status?: number;
  readonly path?: string;
  readonly cause?: unknown;
}> {}

export interface SyncErrorData {
  readonly stage: "source" | "discover" | "bundle" | "collect" | "project";
  readonly message: string;
  readonly diagnostics?: readonly FileDiagnostic[];
}

export interface GitHubSkippedArtifact {
  readonly path: string;
  readonly reason: "not supported yet" | "unsupported file type" | "ignored";
}

export type GitHubSyncResult =
  | {
      readonly status: "published";
      readonly snapshotId: SnapshotId;
      readonly upstreamSha: string;
      readonly tools: readonly string[];
      readonly skipped: readonly GitHubSkippedArtifact[];
      readonly errors?: undefined;
    }
  | {
      readonly status: "up-to-date";
      readonly upstreamSha: string;
      readonly tools: readonly string[];
      readonly skipped: readonly GitHubSkippedArtifact[];
      readonly errors?: undefined;
    }
  | {
      readonly status: "failed";
      readonly upstreamSha?: string;
      readonly tools: readonly string[];
      readonly skipped: readonly GitHubSkippedArtifact[];
      readonly errors: readonly SyncErrorData[];
    };

export interface SyncGitHubSourceInput extends GitHubSourceInput {
  readonly runtime: AppsRuntime;
  readonly tenant?: string;
  readonly scope: string;
}

const TOOL_RE = /^tools\/([a-z0-9][a-z0-9-]*)\.(ts|tsx|js|jsx)$/;
const DEFERRED_RE = /^(workflows|ui|skills)\//;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

const trimBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const repoParts = (repo: string): { owner: string; name: string } | null => {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, name };
};

const encodedRepoPath = (repo: string): Effect.Effect<string, GitHubSourceError> => {
  const parsed = repoParts(repo);
  if (!parsed) {
    return Effect.fail(
      new GitHubSourceError({
        message: `GitHub repo must be "owner/name"; got "${repo}"`,
        path: repo,
      }),
    );
  }
  return Effect.succeed(`${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`);
};

const acceptedPath = (path: string): boolean => path === "executor.json" || TOOL_RE.test(path);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const requestJson = <A>(
  input: GitHubSourceInput,
  path: string,
): Effect.Effect<A, GitHubSourceError> =>
  Effect.tryPromise({
    try: async () => {
      const fetchImpl = input.fetch ?? globalThis.fetch;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "executor-apps-github-source",
      };
      if (input.token) headers.authorization = `Bearer ${input.token}`;
      const response = await fetchImpl(
        `${trimBaseUrl(input.baseUrl ?? "https://api.github.com")}${path}`,
        {
          headers,
        },
      );
      if (!response.ok) {
        throw new GitHubSourceError({
          message: `GitHub request failed: GET ${path} -> ${response.status}`,
          status: response.status,
          path,
        });
      }
      return (await response.json()) as A;
    },
    catch: (cause) =>
      cause instanceof GitHubSourceError
        ? cause
        : new GitHubSourceError({
            message: `GitHub request failed: GET ${path}`,
            path,
            cause,
          }),
  });

interface RepoResponse {
  readonly default_branch?: unknown;
}

interface CommitResponse {
  readonly sha?: unknown;
  readonly commit?: {
    readonly tree?: {
      readonly sha?: unknown;
    };
  };
}

interface GitCommitResponse {
  readonly sha?: unknown;
  readonly tree?: {
    readonly sha?: unknown;
  };
}

interface RefResponse {
  readonly object?: {
    readonly sha?: unknown;
  };
}

interface TreeEntry {
  readonly path?: unknown;
  readonly type?: unknown;
  readonly mode?: unknown;
  readonly sha?: unknown;
  readonly size?: unknown;
}

interface TreeResponse {
  readonly tree?: readonly TreeEntry[];
  readonly truncated?: unknown;
}

interface BlobResponse {
  readonly content?: unknown;
  readonly encoding?: unknown;
}

const commitTreeSha = (commit: CommitResponse | GitCommitResponse): string | undefined => {
  if ("commit" in commit) return asString(commit.commit?.tree?.sha);
  if ("tree" in commit) return asString(commit.tree?.sha);
  return undefined;
};

const limitError = (diagnostics: readonly FileDiagnostic[]): PublishError =>
  new PublishError({
    message: `publish payload exceeds limits (${diagnostics.length} problem(s))`,
    stage: "discover",
    diagnostics,
  });

const checkTreeLimits = (entries: readonly TreeEntry[]): PublishError | null => {
  const diagnostics: FileDiagnostic[] = [];
  if (entries.length > PUBLISH_LIMITS.maxFiles) {
    diagnostics.push({
      path: "",
      message: `publish has ${entries.length} files, exceeding the limit of ${PUBLISH_LIMITS.maxFiles}`,
    });
  }
  let total = 0;
  for (const entry of entries) {
    const path = String(entry.path ?? "");
    const size = typeof entry.size === "number" ? entry.size : 0;
    total += size;
    if (size > PUBLISH_LIMITS.maxFileBytes) {
      diagnostics.push({
        path,
        message: `file is ${size} bytes, exceeding the per-file limit of ${PUBLISH_LIMITS.maxFileBytes} bytes`,
      });
    }
  }
  if (total > PUBLISH_LIMITS.maxTotalBytes) {
    diagnostics.push({
      path: "",
      message: `publish total is ${total} bytes, exceeding the total limit of ${PUBLISH_LIMITS.maxTotalBytes} bytes`,
    });
  }
  return diagnostics.length === 0 ? null : limitError(diagnostics);
};

const classifyTreeEntry = (
  entry: TreeEntry,
):
  | {
      readonly kind: "fetch";
      readonly entry: TreeEntry & { readonly path: string; readonly sha: string };
    }
  | { readonly kind: "skip"; readonly skipped: GitHubSkippedArtifact }
  | null => {
  const path = asString(entry.path);
  if (!path) return null;

  const type = asString(entry.type);
  const mode = asString(entry.mode);
  if (type === "tree") return null;
  if (type !== "blob" || !mode || !REGULAR_FILE_MODES.has(mode)) {
    return { kind: "skip", skipped: { path, reason: "unsupported file type" } };
  }

  const sha = asString(entry.sha);
  if (!sha) return { kind: "skip", skipped: { path, reason: "unsupported file type" } };
  if (acceptedPath(path)) return { kind: "fetch", entry: { ...entry, path, sha } };
  if (DEFERRED_RE.test(path)) {
    return { kind: "skip", skipped: { path, reason: "not supported yet" } };
  }
  return { kind: "skip", skipped: { path, reason: "ignored" } };
};

const decodeBlob = (path: string, blob: BlobResponse): Effect.Effect<string, GitHubSourceError> =>
  Effect.try({
    try: () => {
      const encoding = asString(blob.encoding);
      const content = asString(blob.content);
      if (!content || encoding !== "base64") {
        throw new GitHubSourceError({
          message: `GitHub blob ${path} did not return base64 content`,
          path,
        });
      }
      return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
    },
    catch: (cause) =>
      cause instanceof GitHubSourceError
        ? cause
        : new GitHubSourceError({ message: `Failed to decode GitHub blob ${path}`, path, cause }),
  });

const executorDescription = (
  files: FileSet,
): Effect.Effect<string | undefined, GitHubSourceError> =>
  Effect.try({
    try: () => {
      const raw = files.get("executor.json");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return undefined;
      const description = parsed.description;
      return typeof description === "string" ? description : undefined;
    },
    catch: (cause) =>
      new GitHubSourceError({
        message: "executor.json is not valid JSON",
        path: "executor.json",
        cause,
      }),
  });

export const fetchGitHubSource = (
  input: GitHubSourceInput,
): Effect.Effect<GitHubSourceSnapshot, GitHubSourceError | PublishError> =>
  Effect.gen(function* () {
    const repoPath = yield* encodedRepoPath(input.repo);
    const repo = yield* requestJson<RepoResponse>(input, `/repos/${repoPath}`);
    const ref = input.ref ?? asString(repo.default_branch) ?? "main";
    const branchRef = yield* requestJson<RefResponse>(
      input,
      `/repos/${repoPath}/git/ref/${encodeURIComponent(`heads/${ref}`)}`,
    ).pipe(Effect.result);
    const commitPath =
      Result.isSuccess(branchRef) && asString(branchRef.success.object?.sha)
        ? `/repos/${repoPath}/git/commits/${encodeURIComponent(String(branchRef.success.object?.sha))}`
        : `/repos/${repoPath}/commits/${encodeURIComponent(ref)}`;
    const commit = yield* requestJson<CommitResponse | GitCommitResponse>(input, commitPath);
    const upstreamSha = asString(commit.sha);
    const treeSha = commitTreeSha(commit);
    if (!upstreamSha || !treeSha) {
      return yield* new GitHubSourceError({
        message: `GitHub commit ${ref} did not include a commit SHA and tree SHA`,
        path: commitPath,
      });
    }

    const tree = yield* requestJson<TreeResponse>(
      input,
      `/repos/${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    );
    if (tree.truncated === true) {
      return yield* new GitHubSourceError({
        message: "GitHub returned a truncated repository tree; custom tools source is too large",
        path: `/repos/${repoPath}/git/trees/${treeSha}`,
      });
    }
    const entries: (TreeEntry & { readonly path: string; readonly sha: string })[] = [];
    const skipped: GitHubSkippedArtifact[] = [];
    for (const entry of tree.tree ?? []) {
      const classified = classifyTreeEntry(entry);
      if (!classified) continue;
      if (classified.kind === "fetch") entries.push(classified.entry);
      else skipped.push(classified.skipped);
    }
    const treeLimitError = checkTreeLimits(entries);
    if (treeLimitError) return yield* Effect.fail(treeLimitError);

    const files = new Map<string, string>();
    for (const entry of entries) {
      const path = String(entry.path);
      const blob = yield* requestJson<BlobResponse>(
        input,
        `/repos/${repoPath}/git/blobs/${encodeURIComponent(String(entry.sha))}`,
      );
      files.set(path, yield* decodeBlob(path, blob));
    }
    const payloadLimitError = enforcePublishLimits(files);
    if (payloadLimitError) return yield* Effect.fail(payloadLimitError);

    return {
      files,
      repo: input.repo,
      ref,
      upstreamSha,
      description: yield* executorDescription(files),
      skipped,
    };
  });

const publishErrorToSyncError = (error: PublishError): SyncErrorData => ({
  stage: error.stage,
  message: error.message,
  diagnostics: error.diagnostics,
});

const sourceErrorToSyncError = (error: GitHubSourceError): SyncErrorData => ({
  stage: "source",
  message: error.message,
  diagnostics: error.path ? [{ path: error.path, message: error.message }] : [],
});

const sourceRef = (snapshot: GitHubSourceSnapshot): AppSourceRef => ({
  kind: "github",
  repo: snapshot.repo,
  ref: snapshot.ref,
  upstreamSha: snapshot.upstreamSha,
});

export const syncGitHubSource = (input: SyncGitHubSourceInput): Effect.Effect<GitHubSyncResult> =>
  Effect.gen(function* () {
    const fetched = yield* fetchGitHubSource(input).pipe(Effect.result);
    if (Result.isFailure(fetched)) {
      const error = fetched.failure;
      return {
        status: "failed",
        tools: [],
        skipped: [],
        errors: [
          error instanceof PublishError
            ? publishErrorToSyncError(error)
            : sourceErrorToSyncError(error),
        ],
      } satisfies GitHubSyncResult;
    }
    const snapshot = fetched.success;
    const current = input.tenant
      ? yield* input.runtime.getDescriptor(input.tenant, input.scope)
      : yield* input.runtime.getDescriptor(input.scope);
    if (
      current?.source?.kind === "github" &&
      current.source.repo === snapshot.repo &&
      current.source.upstreamSha === snapshot.upstreamSha
    ) {
      return {
        status: "up-to-date",
        upstreamSha: snapshot.upstreamSha,
        tools: current.tools.map((tool) => tool.name),
        skipped: [...snapshot.skipped, ...(current.skipped ?? [])],
      } satisfies GitHubSyncResult;
    }

    const published = yield* input.runtime
      .publish({
        tenant: input.tenant,
        scope: input.scope,
        files: snapshot.files,
        description: snapshot.description,
        source: sourceRef(snapshot),
        message: `sync ${snapshot.repo}@${snapshot.upstreamSha}`,
      })
      .pipe(Effect.result);
    if (Result.isFailure(published)) {
      return {
        status: "failed",
        upstreamSha: snapshot.upstreamSha,
        tools: [],
        skipped: snapshot.skipped,
        errors: [publishErrorToSyncError(published.failure)],
      } satisfies GitHubSyncResult;
    }

    return {
      status: "published",
      snapshotId: published.success.snapshotId,
      upstreamSha: snapshot.upstreamSha,
      tools: published.success.descriptor.tools.map((tool) => tool.name),
      skipped: [...snapshot.skipped, ...published.success.skipped],
    } satisfies GitHubSyncResult;
  });
