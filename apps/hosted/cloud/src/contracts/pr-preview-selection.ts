export const previewCommitPattern = /^[a-f0-9]{40}$/u;
export const previewRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export const previewSlug = (number: number) => `pr-${number}`;
export const previewOwner = (repository: string, number: number) =>
  `GitHub PR preview: ${repository}#${number}`;
export const previewOrigin = (number: number) =>
  `https://${previewSlug(number)}.executor.engineering`;

const unshownPaths: ReadonlyArray<RegExp> = [
  /^e2e\//u,
  /^apps\/hosted\/self-host\//u,
  /^apps\/hosted\/testing\//u,
  /^apps\/local\//u,
  /^apps\/cli\//u,
  /^\.github\/(?!workflows\/pr-previews?\.yml$|actions\/setup\/)/u,
  /^notes\//u,
  /^plans\//u,
  /^\.agents\//u,
  /^\.claude\//u,
  /^scripts\/(?!pack-test-apps\.ts$)/u,
  /^patches\/[^/]+\.md$/u,
  /^patches\/playwright-core@[^/]+\.patch$/u,
  /^[^/]+\.md$/u,
  /(^|\/)(AGENTS|CLAUDE)\.md$/u,
  /^\.oxlintrc\.jsonc$/u,
  /^\.oxfmtrc\.json$/u,
  /^\.gitignore$/u,
  /^\.gitattributes$/u,
];
export const previewShows = (paths: ReadonlyArray<string>) =>
  paths.some((path) => !unshownPaths.some((pattern) => pattern.test(path)));
export const compareFileLimit = 300;

export const previewCommentMarker = "<!-- executor-pr-preview -->";
export type PreviewStatus =
  | "deploying"
  | "ready"
  | "failed"
  | "closed"
  | "stacked"
  | "unneeded"
  | "cleanup-failed";
export const previewStatusLine = (status: PreviewStatus) =>
  `<!-- executor-pr-preview-status: ${status} -->`;
const removedStatuses: ReadonlyArray<PreviewStatus> = ["closed", "stacked", "unneeded"];
export const previewMayExist = (comment: string) =>
  !removedStatuses.some((status) => comment.includes(previewStatusLine(status)));
