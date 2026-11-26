import { Schema } from "effect";
import { compareReleaseVersions, ReleaseVersion } from "./config.ts";

export const NotesHistory = Schema.Struct({
  since: ReleaseVersion,
  releases: Schema.Array(
    Schema.Struct({
      version: ReleaseVersion,
      notes: Schema.Array(Schema.Struct({ area: Schema.String, text: Schema.String })),
    }),
  ),
});
export type NotesHistory = typeof NotesHistory.Type;

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
