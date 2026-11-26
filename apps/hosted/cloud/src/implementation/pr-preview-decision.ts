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

export class PreviewSelectionFailed extends Error {}

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
const repositoryName = (value: unknown) => (value === null ? null : text(fields(value).full_name));

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
  return above.some((name) => name === repository);
};
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
    if (comments.length < 100) return newest !== undefined && previewMayExist(newest);
  }
};
export const previewMayRemainAfter = (event: string, repository: string, number: number) =>
  event === "pull_request" ? previewMayRemain(repository, number) : Promise.resolve(true);

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
