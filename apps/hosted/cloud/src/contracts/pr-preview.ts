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

/** Where a preview serves its dashboard and sign-in: `app.` under its own host (`stage.ts`). */
export const previewBrowserOrigin = (number: number) =>
  `https://app.${previewSlug(number)}.executor.engineering`;
