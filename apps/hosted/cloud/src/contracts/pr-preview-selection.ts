/**
 * Which pull requests get a preview, with no dependency: the preview workflow decides before it
 * installs any, so a stack layer that cannot install by itself is still retired cleanly.
 */

/** Git object identities are passed to checkout and displayed without accepting arbitrary refs. */
export const previewCommitPattern = /^[a-f0-9]{40}$/u;
/** Repository paths passed to the GitHub API must have exactly two path components. */
export const previewRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Reserved namespace for previews managed by the PR workflow. */
export const previewSlug = (number: number) => `pr-${number}`;
/** Exact registry ownership prevents reconciliation from removing somebody else's preview. */
export const previewOwner = (repository: string, number: number) =>
  `GitHub PR preview: ${repository}#${number}`;
/** Every preview uses the existing production OAuth proxy's trusted dashboard domain. */
export const previewOrigin = (number: number) =>
  `https://${previewSlug(number)}.executor.engineering`;

/**
 * Paths a deployed preview cannot show: the tests, CI, notes and tooling around the product.
 * This lists what does NOT need a preview, so a directory added later gets one until it is listed
 * here; a missing entry costs a test-stage slot, never a preview a change needed.
 */
const unshownPaths: ReadonlyArray<RegExp> = [
  /^e2e\//u,
  // The other products. No Cloud package depends on them, and no Cloud source imports them:
  // `hosted-testing` imports self-host only for local development, which no stage runs.
  /^apps\/hosted\/self-host\//u,
  /^apps\/hosted\/testing\//u,
  /^apps\/local\//u,
  /^apps\/cli\//u,
  // The preview workflows and the toolchain setup can only be proven by deploying a preview.
  /^\.github\/(?!workflows\/pr-previews?\.yml$|actions\/setup\/)/u,
  /^notes\//u,
  /^plans\//u,
  /^\.agents\//u,
  /^\.claude\//u,
  // `pack-test-apps.ts` packs the apps framework every stage serves (`test-stage deploy`).
  /^scripts\/(?!pack-test-apps\.ts$)/u,
  // Patches change what deploys, except the one for the browser driver only tests use.
  /^patches\/[^/]+\.md$/u,
  /^patches\/playwright-core@[^/]+\.patch$/u,
  /^[^/]+\.md$/u,
  /(^|\/)(AGENTS|CLAUDE)\.md$/u,
  /^\.oxlintrc\.jsonc$/u,
  /^\.oxfmtrc\.json$/u,
  /^\.gitignore$/u,
  /^\.gitattributes$/u,
];
/** Whether a change to these repository paths can alter what a deployed preview shows or does. */
export const previewShows = (paths: ReadonlyArray<string>) =>
  paths.some((path) => !unshownPaths.some((pattern) => pattern.test(path)));
/** GitHub's compare API lists at most this many files; a longer diff is assumed to need a preview. */
export const compareFileLimit = 300;

/** The first line of the comment the workflow keeps on each previewed PR (`alchemy.pr-preview.ts`). */
export const previewCommentMarker = "<!-- executor-pr-preview -->";
/** What the workflow last did to a PR's preview, as its comment reports it. */
export type PreviewStatus =
  | "deploying"
  | "ready"
  | "failed"
  | "closed"
  | "stacked"
  | "unneeded"
  | "cleanup-failed";
/** The comment's second line: its status, for the workflow to read back. */
export const previewStatusLine = (status: PreviewStatus) =>
  `<!-- executor-pr-preview-status: ${status} -->`;
/** Statuses the workflow reports only after it removed the stage. */
const removedStatuses: ReadonlyArray<PreviewStatus> = ["closed", "stacked", "unneeded"];
/**
 * Whether a preview comment says the PR's stage may still exist. The workflow writes `deploying`
 * before it creates a stage and a removed status only after removing it, so any other status, or
 * a comment from before the status line, may have a stage behind it.
 */
export const previewMayExist = (comment: string) =>
  !removedStatuses.some((status) => comment.includes(previewStatusLine(status)));
