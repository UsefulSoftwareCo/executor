import { Schema } from "effect";

export const maxNoteLength = 300;

const noteCharacter = /^[A-Za-z0-9 .,;:!?'"()-]$/u;

const shown = (character: string) =>
  /^[!-~]$/u.test(character)
    ? `"${character}"`
    : `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

export const refusal = (text: string): string | undefined => {
  const characters = Array.from(text);
  if (characters.length > maxNoteLength) return `is longer than ${maxNoteLength} characters`;
  const other = characters.find((character) => !noteCharacter.test(character));
  if (other !== undefined) return `holds ${shown(other)}, which a note may not`;
  if (!/^[A-Za-z0-9]/u.test(text)) return "does not start with a letter or a digit";
  if (/^[0-9]+[.)]/u.test(text)) return "starts like a numbered list";
  if (/:(?! |$)/u.test(text)) return "has a colon followed by something other than a space";
  if (/\.(?=[A-Za-z])|(?<![0-9])\.(?=[0-9])/u.test(text))
    return "has a dot inside a word, as in a host name";
  if (/[A-Za-z]-[0-9]/u.test(text)) return "joins letters to digits with a hyphen, as in GH-123";
  if (text.split(/[^A-Za-z0-9]+/u).some((word) => /^[0-9A-Fa-f]{7,}$/u.test(word)))
    return "has a whole word of 7 or more hex characters or digits, as in a commit hash";
  if (/\bghsa-/iu.test(text)) return "names a security advisory";
  if (/executor-next/iu.test(text)) return "names a private repository";
  return undefined;
};

export const isPlainNote = (text: string) => refusal(text) === undefined;

export const noteKinds = ["feature", "improvement", "fix"] as const;
export type NoteKind = (typeof noteKinds)[number];

export const kindOfNote = (line: string): { readonly kind: NoteKind; readonly text: string } => {
  const marked = /^(feature|improvement|fix):(?: (.*))?$/iu.exec(line);
  if (marked === null) return { kind: "fix", text: line };
  return { kind: marked[1]!.toLowerCase() as NoteKind, text: marked[2] ?? "" };
};

export const noteProducts = ["cloud", "local", "self-host"] as const;
export type NoteProduct = (typeof noteProducts)[number];

export const noteProductNames: Readonly<Record<NoteProduct, string>> = {
  cloud: "Cloud",
  local: "CLI and desktop",
  "self-host": "Self-host",
};

export const releasePageUrl = (version: string) =>
  `https://github.com/UsefulSoftwareCo/executor/releases/tag/${encodeURIComponent(`executor@${version}`)}`;

export const cloudNoteDays = 30;

export const CloudReleaseNotes = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
      text: Schema.String,
      kind: Schema.Literals(noteKinds),
      lead: Schema.optional(Schema.Literal(true)),
    }),
  ),
});
export type CloudReleaseNotes = typeof CloudReleaseNotes.Type;

export const whatsNewHeadline = <
  Note extends { readonly kind: NoteKind; readonly lead?: true | undefined },
>(
  notes: ReadonlyArray<Note>,
) => notes.find((note) => note.lead === true) ?? notes.find((note) => note.kind !== "fix");
