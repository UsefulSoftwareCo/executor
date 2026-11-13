/** GitHub PR identity also owns the stage slug and reporting stack identity. */
import { Config, Effect, Schema } from "effect";
import {
  previewCommitPattern,
  previewRepositoryPattern,
  previewSlug,
} from "./pr-preview-selection.ts";

/** Only positive PR numbers can select an automatically managed preview. */
export const PreviewNumber = Schema.Int.check(Schema.isGreaterThan(0));
/** Git object identities are passed to checkout and displayed without accepting arbitrary refs. */
export const PreviewCommit = Schema.String.check(Schema.isPattern(previewCommitPattern));
/** Repository paths passed to the GitHub API must have exactly two path components. */
export const PreviewRepository = Schema.String.check(Schema.isPattern(previewRepositoryPattern));
/** The workflow supplies its repository, never a repository named by the PR author. */
export const previewRepository = Config.String("GITHUB_REPOSITORY").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(PreviewRepository)),
);
/** Where a preview serves its dashboard and sign-in: `app.` under its own host (`stage.ts`). */
export const previewBrowserOrigin = (number: number) =>
  `https://app.${previewSlug(number)}.executor.engineering`;
