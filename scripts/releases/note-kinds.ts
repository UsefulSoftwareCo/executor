/**
 * A STOPGAP for a note merged before a `Release-note:` line could name its kind. Do not add to
 * it: a new note names its own kind in the line, as in `Release-note: Feature: <text>` or
 * `Release-note: Improvement: <text>` (`kindOfNote` in packages/utils/src/release-notes.ts, and
 * "Release notes" in RELEASING.md). A commit message on main cannot change, so this one is given
 * here by hand instead. #4972's note, merged the same day, is left unmarked on purpose, so it stays
 * a fix and does not lead: at 261 characters it is too long for the sidebar's block.
 *
 * Each entry is a squashed pull request's number, as its title on main ends `(#<number>)`, and its
 * note's exact text. Only an unmarked note of that pull request with that text gets the kind; any
 * other note stays a fix. Only Cloud's notes read a kind, and only those of the 30 days before the
 * deployed commit (`cloudNoteDays`), so an entry whose commit has left that window does nothing.
 *
 * Delete this file, and its use in release-notes.ts, once its commit has left the window: a deploy
 * of a commit committed after 2026-12-18 00:40:24 UTC does not read it (#4903 was committed to main
 * at 2026-11-18 00:40:24 UTC; the window is the 30 days before the deployed commit's own time).
 */
import type { NoteKind } from "@executor-js/utils/release-notes";

export const earlierNoteKinds: ReadonlyArray<{
  readonly pullRequest: number;
  readonly text: string;
  readonly kind: NoteKind;
}> = [
  {
    // Shorten the connect form's host list, 3acbadfc52ac5efe2eefe2e7fc1822ab429c3c0f.
    pullRequest: 4903,
    text: "The connect account dialog now sums up a long list of hosts a credential may be sent to by domain, with a button that shows every host.",
    kind: "improvement",
  },
];

/** The kind `earlierNoteKinds` gives a note of the change titled `title`, if it gives one. */
export const earlierNoteKind = (title: string, text: string): NoteKind | undefined => {
  const number = /\(#(\d+)\)$/u.exec(title.trim())?.[1];
  if (number === undefined) return undefined;
  return earlierNoteKinds.find(
    (entry) => entry.pullRequest === Number(number) && entry.text === text,
  )?.kind;
};
