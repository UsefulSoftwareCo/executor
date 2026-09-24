import { Data, Duration, Effect, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Uint8ArrayReader, ZipReader, type FileEntry } from "@zip.js/zip.js";
import {
  isSafeSkillFilePath,
  OrgWriteDeniedError,
  parseGitHubSkillInput,
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_TOTAL_BYTES,
  SkillSourceUnavailableError,
  SkillPackageRejectedError,
  type Executor,
  type GitHubSkillInput,
  type Owner,
  type SkillCandidate,
  type StorageFailure,
} from "@executor-js/sdk";

const GitHubRepository = Schema.Struct({ default_branch: Schema.String });
const GitHubCommit = Schema.Struct({ sha: Schema.String });
const GitHubTree = Schema.Struct({
  truncated: Schema.optional(Schema.Boolean),
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.String,
      size: Schema.optional(Schema.Number),
    }),
  ),
});

const apiRoot = "https://api.github.com";
const githubRoot = "https://github.com";
const rawRoot = "https://raw.githubusercontent.com";
const maxCandidates = 50;
const maxArchiveBytes = 25 * 1024 * 1024;
const maxArchiveEntries = 20_000;

class GitHubRateLimitError extends Data.TaggedError("GitHubRateLimitError") {}

const sourceFailure = (message: string) => new SkillSourceUnavailableError({ message });

const decodeRepository = Schema.decodeUnknownEffect(GitHubRepository);
const decodeCommit = Schema.decodeUnknownEffect(GitHubCommit);
const decodeTree = Schema.decodeUnknownEffect(GitHubTree);

const request = (url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("user-agent", "executor-managed-skills"),
        ),
      )
      .pipe(
        Effect.timeout(Duration.seconds(20)),
        Effect.mapError(() => sourceFailure("GitHub could not be reached.")),
      );
  });

const successful = (status: number, context: string) =>
  status === 404
    ? Effect.fail(sourceFailure(`${context} was not found on GitHub.`))
    : status === 403 || status === 429
      ? Effect.fail(new GitHubRateLimitError())
      : status >= 400
        ? Effect.fail(sourceFailure(`GitHub returned HTTP ${status} while reading ${context}.`))
        : Effect.void;

const successfulPublicRequest = (status: number, context: string) =>
  status === 404
    ? Effect.fail(sourceFailure(`${context} was not found on GitHub.`))
    : status >= 400
      ? Effect.fail(sourceFailure(`GitHub returned HTTP ${status} while reading ${context}.`))
      : Effect.void;

const skillDirectories = (paths: readonly string[], root: string): readonly string[] => {
  const prefix = root === "" ? "" : `${root}/`;
  const directories = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    if (path === "SKILL.md" || path.endsWith("/SKILL.md")) {
      directories.add(path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length));
    }
  }
  return [...directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
};

export interface DiscoverGitHubSkillsInput {
  readonly input?: string;
  readonly resolvedInput?: GitHubSkillInput;
  readonly owner: Owner;
  readonly tracking: "pin" | "follow";
}

export interface DiscoverGitHubSkillsResult {
  readonly candidates: readonly SkillCandidate[];
  readonly rejected: readonly { readonly directory: string; readonly reason: string }[];
  readonly truncated: boolean;
}

interface RepositoryBlob {
  readonly size: number;
  readonly read: Effect.Effect<Uint8Array, SkillSourceUnavailableError, HttpClient.HttpClient>;
}

const stageCandidates = (
  executor: Executor,
  input: DiscoverGitHubSkillsInput,
  source: GitHubSkillInput,
  requestedRef: string,
  commit: string,
  blobs: ReadonlyMap<string, RepositoryBlob>,
): Effect.Effect<
  DiscoverGitHubSkillsResult,
  SkillSourceUnavailableError | SkillPackageRejectedError | OrgWriteDeniedError | StorageFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const repositoryLabel = `${source.owner}/${source.repository}`;
    const directories = skillDirectories([...blobs.keys()], source.directory);
    if (directories.length === 0) {
      return yield* sourceFailure(`No SKILL.md was found under ${repositoryLabel}.`);
    }
    const selected = directories.slice(0, maxCandidates);
    const wanted = new Set(source.selectedSkills);
    const rejected: Array<{ readonly directory: string; readonly reason: string }> = [];
    const candidates = yield* Effect.forEach(
      selected,
      (directory) =>
        Effect.gen(function* () {
          const basename = directory.slice(directory.lastIndexOf("/") + 1);
          if (wanted.size > 0 && !wanted.has(basename)) return null;
          const prefix = directory === "" ? "" : `${directory}/`;
          const nested = directories.filter(
            (other) => other !== directory && other.startsWith(prefix),
          );
          const files = [...blobs.entries()]
            .filter(([path]) => path.startsWith(prefix))
            .map(([fullPath, blob]) => ({
              fullPath,
              path: fullPath.slice(prefix.length),
              blob,
            }))
            .filter(
              (file) =>
                isSafeSkillFilePath(file.path) &&
                !file.path.split("/").some((segment) => segment.startsWith(".")) &&
                !nested.some((child) => file.path.startsWith(`${child.slice(prefix.length)}/`)),
            );
          const totalBytes = files.reduce((total, file) => total + file.blob.size, 0);
          if (
            files.length > SKILL_MAX_FILES ||
            files.some((file) => file.blob.size > SKILL_MAX_FILE_BYTES) ||
            totalBytes > SKILL_MAX_TOTAL_BYTES
          ) {
            rejected.push({ directory, reason: "The package exceeds Executor's size limits." });
            return null;
          }
          const packageFiles = yield* Effect.forEach(
            files,
            (file) => file.blob.read.pipe(Effect.map((bytes) => ({ path: file.path, bytes }))),
            { concurrency: 6 },
          );
          return yield* executor.skills.stageCandidate({
            owner: input.owner,
            package: { files: packageFiles },
            source: {
              locator: {
                kind: "github",
                repository: repositoryLabel,
                directory,
                requestedRef,
                resolvedCommit: commit,
              },
              tracking:
                input.tracking === "follow"
                  ? {
                      kind: "tracked",
                      symbolicReference: requestedRef,
                      resolvedRevision: commit,
                    }
                  : { kind: "pinned", upstreamRevision: commit },
            },
          });
        }).pipe(
          Effect.catchTag("SkillPackageRejectedError", (error) => {
            rejected.push({
              directory,
              reason: error.diagnostics[0]?.message ?? "The package could not be read.",
            });
            return Effect.succeed(null);
          }),
        ),
      { concurrency: 3 },
    );
    return {
      candidates: candidates.filter(Predicate.isNotNull),
      rejected,
      truncated: directories.length > maxCandidates,
    };
  });

const parseCommitFeed = (body: string): Effect.Effect<string, SkillSourceUnavailableError> => {
  const commit = /Grit::Commit\/([0-9a-f]{40})/.exec(body)?.[1];
  return commit === undefined
    ? Effect.fail(sourceFailure("GitHub returned an invalid commit feed."))
    : Effect.succeed(commit);
};

const readArchiveEntry = (
  entry: FileEntry,
  path: string,
): Effect.Effect<Uint8Array, SkillSourceUnavailableError> =>
  Effect.tryPromise({
    try: () => entry.arrayBuffer({ useWebWorkers: false }),
    catch: () => sourceFailure(`GitHub could not read ${path}.`),
  }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

const discoverFromArchive = (
  executor: Executor,
  input: DiscoverGitHubSkillsInput,
  source: GitHubSkillInput,
): Effect.Effect<
  DiscoverGitHubSkillsResult,
  SkillSourceUnavailableError | SkillPackageRejectedError | OrgWriteDeniedError | StorageFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const repositoryLabel = `${source.owner}/${source.repository}`;
    const requestedRef = source.requestedRef ?? "HEAD";
    const feedResponse = yield* request(
      `${githubRoot}/${repositoryLabel}/commits/${encodeURIComponent(requestedRef)}.atom`,
    );
    yield* successfulPublicRequest(feedResponse.status, `${repositoryLabel}@${requestedRef}`);
    const commit = yield* parseCommitFeed(
      yield* feedResponse.text.pipe(
        Effect.mapError(() => sourceFailure("GitHub returned an invalid commit feed.")),
      ),
    );
    const archiveResponse = yield* request(
      `${githubRoot}/${repositoryLabel}/archive/${encodeURIComponent(commit)}.zip`,
    );
    yield* successfulPublicRequest(archiveResponse.status, `${repositoryLabel}@${commit}`);
    const archive = new Uint8Array(
      yield* archiveResponse.arrayBuffer.pipe(
        Effect.mapError(() => sourceFailure("GitHub could not read the repository archive.")),
      ),
    );
    if (archive.byteLength > maxArchiveBytes) {
      return yield* sourceFailure("The GitHub repository archive is too large to import safely.");
    }
    const reader = new ZipReader(new Uint8ArrayReader(archive), { useWebWorkers: false });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(reader),
      (openReader) =>
        Effect.gen(function* () {
          const entries = yield* Effect.tryPromise({
            try: () => openReader.getEntries(),
            catch: () => sourceFailure("GitHub returned an invalid repository archive."),
          });
          if (entries.length > maxArchiveEntries) {
            return yield* sourceFailure(
              "The GitHub repository archive has too many entries to import safely.",
            );
          }
          const root = entries[0]?.filename.split("/")[0];
          if (root === undefined || root === "") {
            return yield* sourceFailure("GitHub returned an invalid repository archive.");
          }
          const prefix = `${root}/`;
          const blobs = new Map<string, RepositoryBlob>();
          for (const entry of entries) {
            if (entry.directory || !entry.filename.startsWith(prefix)) continue;
            const path = entry.filename.slice(prefix.length);
            if (path === "") continue;
            blobs.set(path, {
              size: entry.uncompressedSize,
              read: readArchiveEntry(entry, path),
            });
          }
          return yield* stageCandidates(executor, input, source, requestedRef, commit, blobs);
        }),
      (openReader) => Effect.promise(() => openReader.close()),
    );
  });

export const discoverGitHubSkills = (
  executor: Executor,
  input: DiscoverGitHubSkillsInput,
): Effect.Effect<
  DiscoverGitHubSkillsResult,
  SkillSourceUnavailableError | SkillPackageRejectedError | OrgWriteDeniedError | StorageFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const parsed =
      input.resolvedInput === undefined
        ? parseGitHubSkillInput(input.input ?? "")
        : Option.some(input.resolvedInput);
    if (Option.isNone(parsed))
      return yield* sourceFailure(
        "Enter a GitHub repository, GitHub URL, skills.sh URL, or skills install command.",
      );
    const source = parsed.value;
    const discoverFromApi = Effect.gen(function* () {
      const repositoryLabel = `${source.owner}/${source.repository}`;
      const requestedRef = yield* source.requestedRef === null
        ? Effect.gen(function* () {
            const response = yield* request(`${apiRoot}/repos/${repositoryLabel}`);
            yield* successful(response.status, repositoryLabel);
            const body = yield* response.json.pipe(
              Effect.mapError(() => sourceFailure("GitHub returned invalid JSON.")),
            );
            return (yield* decodeRepository(body).pipe(
              Effect.mapError(() =>
                sourceFailure("GitHub returned an invalid repository response."),
              ),
            )).default_branch;
          })
        : Effect.succeed(source.requestedRef);
      const commitResponse = yield* request(
        `${apiRoot}/repos/${repositoryLabel}/commits/${encodeURIComponent(requestedRef)}`,
      );
      yield* successful(commitResponse.status, `${repositoryLabel}@${requestedRef}`);
      const commit = yield* decodeCommit(
        yield* commitResponse.json.pipe(
          Effect.mapError(() => sourceFailure("GitHub returned invalid JSON.")),
        ),
      ).pipe(Effect.mapError(() => sourceFailure("GitHub returned an invalid commit response.")));
      const treeResponse = yield* request(
        `${apiRoot}/repos/${repositoryLabel}/git/trees/${encodeURIComponent(commit.sha)}?recursive=1`,
      );
      yield* successful(treeResponse.status, `${repositoryLabel}@${commit.sha}`);
      const tree = yield* decodeTree(
        yield* treeResponse.json.pipe(
          Effect.mapError(() => sourceFailure("GitHub returned invalid JSON.")),
        ),
      ).pipe(Effect.mapError(() => sourceFailure("GitHub returned an invalid repository tree.")));
      if (tree.truncated === true) {
        return yield* sourceFailure("The GitHub repository tree is too large to import safely.");
      }
      const blobs = new Map<string, RepositoryBlob>(
        tree.tree
          .filter((entry) => entry.type === "blob")
          .map((entry) => {
            const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
            return [
              entry.path,
              {
                size: entry.size ?? 0,
                read: Effect.gen(function* () {
                  const response = yield* request(
                    `${rawRoot}/${repositoryLabel}/${encodeURIComponent(commit.sha)}/${encodedPath}`,
                  );
                  yield* successfulPublicRequest(response.status, entry.path);
                  return new Uint8Array(
                    yield* response.arrayBuffer.pipe(
                      Effect.mapError(() => sourceFailure(`GitHub could not read ${entry.path}.`)),
                    ),
                  );
                }),
              },
            ];
          }),
      );
      return yield* stageCandidates(executor, input, source, requestedRef, commit.sha, blobs);
    });
    return yield* discoverFromApi.pipe(
      Effect.catchTag("GitHubRateLimitError", () => discoverFromArchive(executor, input, source)),
    );
  });
