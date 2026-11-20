/**
 * The release notes as plain text that `release-notes.ts --json` writes and the desktop update
 * feed carries (`desktop-feed.ts`): one release's notes and those of the releases before it,
 * newest first, and the release after which the list is whole. Both scripts hold the file to
 * `notesHistoryProblem`, the writer before it writes and the feed when it reads, so the writer
 * cannot emit notes that the feed refuses.
 */
import { Schema } from "effect";
import { compareReleaseVersions, ReleaseVersion } from "./config.ts";

export const NotesHistory = Schema.Struct({
  /** Every release after this one, up to the first listed, is listed; none before it is. */
  since: ReleaseVersion,
  releases: Schema.Array(
    Schema.Struct({
      version: ReleaseVersion,
      notes: Schema.Array(Schema.Struct({ area: Schema.String, text: Schema.String })),
    }),
  ),
});
export type NotesHistory = typeof NotesHistory.Type;

/**
 * Why `history` is not the notes of `version` as the feed carries them, or undefined when it is:
 * `version` first, then each listed release older than the one before it, all after `since`. A
 * release before `since` cannot be listed. Nothing says which releases are missing before such
 * a release, so a reader would show it as if the releases after it were all there.
 */
export const notesHistoryProblem = (
  history: NotesHistory,
  version: typeof ReleaseVersion.Type,
): string | undefined => {
  const { releases, since } = history;
  if (releases[0]?.version !== version) return `does not start with ${version}`;
  const descending = releases.every(
    (entry, index) =>
      index === 0 || compareReleaseVersions(releases[index - 1]!.version, entry.version) > 0,
  );
  if (!descending) return "does not list its releases newest first";
  if (compareReleaseVersions(releases.at(-1)!.version, since) <= 0)
    return `lists a release that is not after its since, ${since}`;
  return undefined;
};
