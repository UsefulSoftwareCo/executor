/** GitHub PR identity also owns the stage slug and reporting stack identity. */
import { Config, Effect, Schema } from "effect";

/** Only positive PR numbers can select an automatically managed preview. */
export const PreviewNumber = Schema.Int.check(Schema.isGreaterThan(0));
/** Git object identities are passed to checkout and displayed without accepting arbitrary refs. */
export const PreviewCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
/** Repository paths passed to the GitHub API must have exactly two path components. */
export const PreviewRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
);
/** The workflow supplies its repository, never a repository named by the PR author. */
export const previewRepository = Config.String("GITHUB_REPOSITORY").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(PreviewRepository)),
);
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

/** Where a preview serves its dashboard and sign-in: `app.` under its own host (`stage.ts`). */
export const previewBrowserOrigin = (number: number) =>
  `https://app.${previewSlug(number)}.executor.engineering`;
