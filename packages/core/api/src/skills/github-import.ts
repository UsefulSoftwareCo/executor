// ---------------------------------------------------------------------------
// Import skills from a GitHub repository.
//
// One tree listing (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`)
// finds every SKILL.md under the requested path, then each skill directory's
// text files are read through the raw content host. That is the same route
// `npx skills`, `gh skill`, and skills.sh take, minus the git clone: nothing
// touches disk, and a private repo simply reports as not found.
//
// The result is a list of CANDIDATES — each already validated by
// `prepareSkillFiles` so the console can show the name and description before
// the user picks which to save. Saving goes through the ordinary `skills.save`
// endpoint; this route never writes.
// ---------------------------------------------------------------------------

import { Duration, Effect, Option, Predicate, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  isValidSkillFilePath,
  prepareSkillFiles,
  SKILL_MD_PATH,
  SkillSourceError,
  formatGitHubSkillSource,
  type GitHubSkillSource,
  type SkillFileInput,
  type SkillName,
} from "@executor-js/sdk";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const USER_AGENT = "executor-skills-import";

/** Skills per import; a monorepo of hundreds gets the first N and a note. */
export const GITHUB_IMPORT_MAX_SKILLS = 50;
/** Files read per skill; matches the save limit so nothing is fetched for naught. */
const MAX_FILES_PER_SKILL = 64;
/** Per-file byte cap from the tree listing, before any content is read. */
const MAX_FILE_BYTES = 512 * 1024;
/** Extensions treated as text. Anything else is a binary the format cannot carry. */
const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "html",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "gql",
  "ini",
  "cfg",
  "conf",
  "env",
  "example",
  "template",
  "tpl",
  "hbs",
  "mustache",
  "j2",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "pl",
  "lua",
  "r",
  "jl",
  "ex",
  "exs",
  "erl",
  "hs",
  "scala",
  "clj",
  "ps1",
  "bat",
  "cmd",
  "mdx",
  "rst",
  "adoc",
  "tex",
  "svg",
]);

const TreeResponse = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.optional(Schema.Boolean),
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.String,
      size: Schema.optional(Schema.Number),
    }),
  ),
});

const RepoResponse = Schema.Struct({ default_branch: Schema.String });

const decodeTree = Schema.decodeUnknownResult(Schema.fromJsonString(TreeResponse));
const decodeRepo = Schema.decodeUnknownResult(Schema.fromJsonString(RepoResponse));

export interface GitHubSkillCandidate {
  /** Directory inside the repo, `""` when the repo root is the skill. */
  readonly directory: string;
  readonly name: SkillName;
  readonly description: string;
  readonly files: readonly SkillFileInput[];
}

export interface GitHubImportResult {
  readonly source: string;
  readonly ref: string;
  readonly skills: readonly GitHubSkillCandidate[];
  /** Directories with a SKILL.md that did not validate, with the reason. */
  readonly rejected: readonly { readonly directory: string; readonly reason: string }[];
  /** True when more skills existed than {@link GITHUB_IMPORT_MAX_SKILLS}. */
  readonly truncated: boolean;
}

const fail = (reason: string) => Effect.fail(new SkillSourceError({ reason }));

const isTextPath = (path: string): boolean => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1) return /^(LICENSE|README|Makefile|Dockerfile|CHANGELOG|NOTICE)$/i.test(base);
  return TEXT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
};

/** Skill directories are the parents of every SKILL.md at or under `path`. */
export const skillDirectoriesInTree = (
  paths: readonly string[],
  root: string,
): readonly string[] => {
  const prefix = root === "" ? "" : `${root}/`;
  const found = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    if (path === SKILL_MD_PATH || path.endsWith(`/${SKILL_MD_PATH}`)) {
      found.add(path === SKILL_MD_PATH ? "" : path.slice(0, -(SKILL_MD_PATH.length + 1)));
    }
  }
  // Shallow first so `skills/foo` lists before `skills/foo/nested`; ties by name.
  return [...found].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
};

export const importSkillsFromGitHub = (
  source: GitHubSkillSource,
): Effect.Effect<GitHubImportResult, SkillSourceError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const label = formatGitHubSkillSource(source);

    const get = (url: string, accept: string) =>
      http
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("user-agent", USER_AGENT),
            HttpClientRequest.setHeader("accept", accept),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (text) => ({ status: response.status, text })),
          ),
          Effect.timeout(Duration.seconds(20)),
          Effect.catch(() => fail(`GitHub could not be reached while importing ${label}.`)),
        );

    const notFound = `${label} was not found on GitHub. Check the URL, and note that private repositories cannot be imported.`;
    const guardStatus = (status: number) =>
      status === 404
        ? fail(notFound)
        : status === 403 || status === 429
          ? fail("GitHub rate-limited the import. Try again in a few minutes.")
          : status >= 400
            ? fail(`GitHub answered ${status} while importing ${label}.`)
            : Effect.void;

    // The ref: what the URL named, else the repository's default branch.
    const ref = yield* source.ref
      ? Effect.succeed(source.ref)
      : Effect.gen(function* () {
          const repo = yield* get(
            `${GITHUB_API}/repos/${source.owner}/${source.repo}`,
            "application/vnd.github+json",
          );
          yield* guardStatus(repo.status);
          const decoded = decodeRepo(repo.text);
          if (Result.isFailure(decoded)) return yield* fail(notFound);
          return decoded.success.default_branch;
        });

    const treeResponse = yield* get(
      `${GITHUB_API}/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      "application/vnd.github+json",
    );
    yield* guardStatus(treeResponse.status);
    const tree = decodeTree(treeResponse.text);
    if (Result.isFailure(tree)) return yield* fail(notFound);

    const blobs = new Map<string, number>();
    for (const entry of tree.success.tree) {
      if (entry.type === "blob") blobs.set(entry.path, entry.size ?? 0);
    }
    const directories = skillDirectoriesInTree([...blobs.keys()], source.path);
    if (directories.length === 0) {
      return yield* fail(
        source.path === ""
          ? `No SKILL.md found anywhere in ${label}.`
          : `No SKILL.md found under ${source.path} in ${source.owner}/${source.repo}.`,
      );
    }
    const truncated = directories.length > GITHUB_IMPORT_MAX_SKILLS;
    const chosen = directories.slice(0, GITHUB_IMPORT_MAX_SKILLS);

    const readSkill = (directory: string) =>
      Effect.gen(function* () {
        const prefix = directory === "" ? "" : `${directory}/`;
        // Files of THIS skill only: a nested skill's files belong to it.
        const nested = directories.filter(
          (other) => other !== directory && other.startsWith(prefix),
        );
        const paths = [...blobs.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, size]) => ({ full: path, path: path.slice(prefix.length), size }))
          .filter(
            ({ path, size }) =>
              isValidSkillFilePath(path) &&
              !path.split("/").some((segment) => segment.startsWith(".")) &&
              size <= MAX_FILE_BYTES &&
              isTextPath(path) &&
              !nested.some((dir) => path.startsWith(`${dir.slice(prefix.length)}/`)),
          )
          .sort((a, b) => (a.path === SKILL_MD_PATH ? -1 : b.path === SKILL_MD_PATH ? 1 : 0))
          .slice(0, MAX_FILES_PER_SKILL);

        const files = yield* Effect.forEach(
          paths,
          ({ full, path }) =>
            Effect.map(
              get(
                `${GITHUB_RAW}/${source.owner}/${source.repo}/${encodeURIComponent(ref)}/${full
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}`,
                "text/plain",
              ),
              (response): SkillFileInput | null =>
                response.status === 200 && !response.text.includes(" ")
                  ? { path, content: response.text }
                  : null,
            ),
          { concurrency: 6 },
        );
        const present = files.filter(Predicate.isNotNull);
        const prepared = yield* Effect.promise(() => prepareSkillFiles(present));
        return Result.match(prepared, {
          onFailure: (error) => ({ directory, reason: error.reason }) as const,
          onSuccess: ({ parsed, files: validated }) =>
            ({
              directory,
              name: parsed.name,
              description: parsed.description,
              files: validated.map(({ path, content }) => ({ path, content })),
            }) as const,
        });
      });

    const outcomes = yield* Effect.forEach(chosen, readSkill, { concurrency: 3 });
    // `--skill x` names the skills wanted; the rest are read but not offered.
    // Matching is by frontmatter name, then by directory basename, so a name
    // that only exists on disk still resolves.
    const wanted = new Set(source.skills);
    const isWanted = (outcome: { readonly directory: string; readonly name?: string }) =>
      wanted.size === 0 ||
      (outcome.name !== undefined && wanted.has(outcome.name)) ||
      wanted.has(outcome.directory.slice(outcome.directory.lastIndexOf("/") + 1));
    const skills: GitHubSkillCandidate[] = [];
    const rejected: { directory: string; reason: string }[] = [];
    for (const outcome of outcomes) {
      if (!isWanted(outcome)) continue;
      if ("reason" in outcome) rejected.push(outcome);
      else skills.push(outcome);
    }
    if (wanted.size > 0 && skills.length === 0 && rejected.length === 0) {
      return yield* fail(
        `No skill named ${[...wanted].map((name) => `\`${name}\``).join(", ")} in ${label}.`,
      );
    }
    return { source: label, ref, skills, rejected, truncated };
  }).pipe(Effect.withSpan("skills.import.github"));

/** Exposed for tests: the parse step the handler runs before any network. */
export const parsedSourceOrError = (
  parsed: Option.Option<GitHubSkillSource>,
): Effect.Effect<GitHubSkillSource, SkillSourceError> =>
  Option.match(parsed, {
    onNone: () =>
      fail(
        "Enter a GitHub repository (owner/repo), a path inside one, a github.com URL, a skills.sh link, or an `npx skills add …` command.",
      ),
    onSome: Effect.succeed,
  });
