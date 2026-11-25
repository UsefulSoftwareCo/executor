import { Config, Effect, Schema } from "effect";
import {
  previewCommitPattern,
  previewRepositoryPattern,
  previewSlug,
} from "./pr-preview-selection.ts";

export const PreviewNumber = Schema.Int.check(Schema.isGreaterThan(0));
export const PreviewCommit = Schema.String.check(Schema.isPattern(previewCommitPattern));
export const PreviewRepository = Schema.String.check(Schema.isPattern(previewRepositoryPattern));
export const previewRepository = Config.String("GITHUB_REPOSITORY").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(PreviewRepository)),
);
export const previewBrowserOrigin = (number: number) =>
  `https://app.${previewSlug(number)}.executor.engineering`;
