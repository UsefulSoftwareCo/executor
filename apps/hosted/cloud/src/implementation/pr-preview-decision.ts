/**
 * The preview workflow's decision, read from GitHub through `gh`, with no dependency. The workflow
 * runs it before it installs anything, so a stack layer that cannot install by itself is retired
 * without installing. `stale` reuses `previewAction` for scheduled reconciliation.
 */
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import {
  compareFileLimit,
  previewCommentMarker,
  previewCommitPattern,
  previewMayExist,
  previewOrigin,
  previewOwner,
  previewRepositoryPattern,
  previewShows,
  previewSlug,
} from "../contracts/pr-preview-selection.ts";

/** A failure whose message is safe to print in a public workflow log. */
export class PreviewSelectionFailed extends Error {}

/** GitHub answered with something this decision does not understand; it never guesses. */
class UnexpectedAnswer extends Error {}
type Fields = Readonly<Record<string, unknown>>;
const fields = (value: unknown): Fields => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new UnexpectedAnswer();
  return Object.fromEntries(Object.entries(value));
};
const list = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new UnexpectedAnswer();
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new UnexpectedAnswer();
  return value;
};
const matching = (value: unknown, pattern: RegExp) => {
  const string = text(value);
  if (!pattern.test(string)) throw new UnexpectedAnswer();
  return string;
};
const positive = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new UnexpectedAnswer();
  return value;
};
/** A repository that GitHub may report as null, as it does for a deleted fork. */
const repositoryName = (value: unknown) => (value === null ? null : text(fields(value).full_name));

/** `gh` with these arguments; its output, or a failure when it exits non-zero. */
const gh = (args: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) =>
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    ),
  );
const ghJson = async (args: ReadonlyArray<string>): Promise<unknown> => JSON.parse(await gh(args));

const pullRequest = async (repository: string, number: number) => {
  const pr = fields(await ghJson(["api", `repos/${repository}/pulls/${number}`]));
  const state = text(pr.state);
  if (state !== "open" && state !== "closed") throw new UnexpectedAnswer();
  const head = fields(pr.head);
  return {
    state,
    head: {
      sha: matching(head.sha, previewCommitPattern),
      ref: text(head.ref),
      repository: repositoryName(head.repo),
    },
    defaultBranch: text(fields(fields(pr.base).repo).default_branch),
  };
};
/** Only the top layer of a stack is previewed; it contains every lower layer's change. */
const isStackedUnder = async (repository: string, ref: string) => {
  const above = list(
    await ghJson([
      "api",
      "--method",
      "GET",
      `repos/${repository}/pulls`,
      "-f",
      "state=open",
      "-f",
      `base=${ref}`,
      "-f",
      "per_page=100",
    ]),
  ).map((pr) => {
    const fieldsOf = fields(pr);
    positive(fieldsOf.number);
    return repositoryName(fields(fieldsOf.head).repo);
  });
  // Fork PRs never get a preview, so they cannot stand in for this one.
  return above.some((name) => name === repository);
};
/**
 * Whether the head's whole change against the default branch can alter what a preview shows. For a
 * stack's top layer that is every layer's change. GitHub lists at most 300 changed files; a longer
 * list may hide one a preview shows, so it counts as one.
 */
const changesPreview = async (repository: string, defaultBranch: string, sha: string) => {
  const compared = fields(
    await ghJson([
      "api",
      `repos/${repository}/compare/${defaultBranch}...${sha}`,
      "--jq",
      "{count: (.files | length), paths: [.files[] | .filename, (.previous_filename // empty)]}",
    ]),
  );
  const count = compared.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new UnexpectedAnswer();
  return count >= compareFileLimit || previewShows(list(compared.paths).map(text));
};

/**
 * `destroy` a closed PR's preview, `retire` a lower stack layer's, and `unneeded` removes the
 * preview of a PR that changes nothing a preview shows. A later push that does deploys it again.
 */
export const previewAction = async (repository: string, number: number) => {
  const pr = await pullRequest(repository, number);
  if (pr.state === "closed") return { pr, action: "destroy" as const };
  if (await isStackedUnder(repository, pr.head.ref)) return { pr, action: "retire" as const };
  return {
    pr,
    action: (await changesPreview(repository, pr.defaultBranch, pr.head.sha))
      ? ("deploy" as const)
      : ("unneeded" as const),
  };
};

/**
 * Whether this PR's preview may still exist, for a run a `pull_request` event started. Every stage
 * the workflow creates is announced in the PR's preview comment first, so a PR without the
 * comment, or whose comment says its stage was removed, has nothing to clean up and needs no
 * install.
 *
 * The workflow's own comment is the newest one written by the `github-actions[bot]` login whose
 * body starts with `previewCommentMarker`; a comment by any other login is ignored. Anyone with
 * write access can still edit or delete that comment, so it only spares pull request runs an
 * install: scheduled reconciliation and a manual dispatch start from the stage registry and
 * never consult it (`previewMayRemainAfter`).
 */
export const previewMayRemain = async (repository: string, number: number) => {
  let newest: string | undefined;
  for (let page = 1; ; page++) {
    const comments = list(
      await ghJson([
        "api",
        "--method",
        "GET",
        `repos/${repository}/issues/${number}/comments`,
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
      ]),
    );
    for (const comment of comments.map(fields)) {
      const author = fields(comment.user);
      const body = text(comment.body);
      if (author.login === "github-actions[bot]" && body.startsWith(previewCommentMarker))
        newest = body;
    }
    // GitHub lists a PR's comments oldest first.
    if (comments.length < 100) return newest !== undefined && previewMayExist(newest);
  }
};
/**
 * Whether a run started by this event may find a preview to remove. Only a `pull_request` run
 * takes the comment's word; the hourly sweep selected the PR from the registry, and a manual
 * dispatch asks for the registry to be acted on, so for them a preview may always remain.
 */
export const previewMayRemainAfter = (event: string, repository: string, number: number) =>
  event === "pull_request" ? previewMayRemain(repository, number) : Promise.resolve(true);

/** The step's outputs, as GitHub Actions reads them from `$GITHUB_OUTPUT`. */
const output = (path: string, values: Readonly<Record<string, string>>) =>
  appendFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );

const setting = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (value === undefined || value === "") throw new PreviewSelectionFailed(`${name} is not set.`);
  return value;
};
const prNumber = (argument: string | undefined) => {
  const number = Number(argument);
  if (argument === undefined || !/^[1-9][0-9]*$/u.test(argument) || !Number.isSafeInteger(number))
    throw new PreviewSelectionFailed("Pass the pull request's number.");
  return number;
};

/**
 * `prepare <number>` writes the action and the preview's identity; `previewed <number>` writes
 * whether a preview of a closed, retired or unneeded PR may remain to be removed.
 */
export const runSelection = async (
  command: "prepare" | "previewed",
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => {
  try {
    const number = prNumber(args[0]);
    const repository = setting(env, "GITHUB_REPOSITORY");
    if (!previewRepositoryPattern.test(repository))
      throw new PreviewSelectionFailed("GITHUB_REPOSITORY is not an owner/name repository.");
    const outputs = setting(env, "GITHUB_OUTPUT");
    if (command === "previewed") {
      const remains = await previewMayRemainAfter(
        setting(env, "PREVIEW_EVENT"),
        repository,
        number,
      );
      await output(outputs, { remains: remains ? "true" : "false" });
      return 0;
    }
    const { pr, action } = await previewAction(repository, number);
    if (pr.head.repository !== repository)
      throw new PreviewSelectionFailed("Fork PRs cannot access preview credentials.");
    await output(outputs, {
      action,
      sha: pr.head.sha,
      slug: previewSlug(number),
      owner: previewOwner(repository, number),
      url: previewOrigin(number),
    });
    return 0;
  } catch (error) {
    console.error(
      error instanceof PreviewSelectionFailed
        ? error.message
        : "PR preview command failed. Check GitHub and staging access.",
    );
    return 1;
  }
};
