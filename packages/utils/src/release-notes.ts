/**
 * What a `Release-note:` line may say. scripts/releases/release-notes.ts publishes only notes this
 * accepts, and the products that show notes accept only these too, so a malformed or tampered
 * notes file can show nothing but plain sentences. Notes are text, never Markdown or HTML.
 */
import { Schema } from "effect";

/** The longest one note may be, in characters; a longer one is left out. */
export const maxNoteLength = 300;

/** The characters a note may hold: ASCII letters and digits, spaces and sentence punctuation. */
const noteCharacter = /^[A-Za-z0-9 .,;:!?'"()-]$/u;

/** A character as a warning may show it: itself when printable ASCII, otherwise its code point. */
const shown = (character: string) =>
  /^[!-~]$/u.test(character)
    ? `"${character}"`
    : `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Why a note may not be published, or undefined when it is plain prose GitHub renders as nothing
 * but its text. This is an allow-list: anything not described here is refused, never rewritten.
 */
export const refusal = (text: string): string | undefined => {
  const characters = Array.from(text);
  if (characters.length > maxNoteLength) return `is longer than ${maxNoteLength} characters`;
  const other = characters.find((character) => !noteCharacter.test(character));
  if (other !== undefined) return `holds ${shown(other)}, which a note may not`;
  if (!/^[A-Za-z0-9]/u.test(text)) return "does not start with a letter or a digit";
  if (/^[0-9]+[.)]/u.test(text)) return "starts like a numbered list";
  if (/:(?! |$)/u.test(text)) return "has a colon followed by something other than a space";
  // A dot may end a sentence or sit between digits (1.5), never inside a word (example.com).
  if (/\.(?=[A-Za-z])|(?<![0-9])\.(?=[0-9])/u.test(text))
    return "has a dot inside a word, as in a host name";
  if (/[A-Za-z]-[0-9]/u.test(text)) return "joins letters to digits with a hyphen, as in GH-123";
  // GitHub links a commit only as a whole word, so a word that merely holds hex letters is fine.
  if (text.split(/[^A-Za-z0-9]+/u).some((word) => /^[0-9A-Fa-f]{7,}$/u.test(word)))
    return "has a whole word of 7 or more hex characters or digits, as in a commit hash";
  if (/\bghsa-/iu.test(text)) return "names a security advisory";
  if (/executor-next/iu.test(text)) return "names a private repository";
  return undefined;
};

/** Whether `text` is a note that may be shown: plain prose that renders as its text alone. */
export const isPlainNote = (text: string) => refusal(text) === undefined;

/** A release's public page, with its notes and installers. */
export const releasePageUrl = (version: string) =>
  `https://github.com/UsefulSoftwareCo/executor/releases/tag/${encodeURIComponent(`executor@${version}`)}`;

/**
 * How many days back Cloud's what's new reaches, from the commit a deploy builds. Cloud deploys
 * every merge to main, so a note goes with the first deploy after it is this old.
 */
export const cloudNoteDays = 30;

/**
 * Cloud's notes as `scripts/releases/release-notes.ts --cloud` writes them and the Cloud dashboard's
 * build takes them: newest first, each the day (`YYYY-MM-DD`, UTC) its change reached main and the
 * note's text.
 */
export const CloudReleaseNotes = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
      text: Schema.String,
    }),
  ),
});
export type CloudReleaseNotes = typeof CloudReleaseNotes.Type;
