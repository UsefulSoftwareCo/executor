import type { NoteKind } from "@executor-js/utils/release-notes";

export const earlierNoteKinds: ReadonlyArray<{
  readonly pullRequest: number;
  readonly text: string;
  readonly kind: NoteKind;
}> = [
  {
    pullRequest: 4903,
    text: "The connect account dialog now sums up a long list of hosts a credential may be sent to by domain, with a button that shows every host.",
    kind: "improvement",
  },
];

export const earlierNoteKind = (title: string, text: string): NoteKind | undefined => {
  const number = /\(#(\d+)\)$/u.exec(title.trim())?.[1];
  if (number === undefined) return undefined;
  return earlierNoteKinds.find(
    (entry) => entry.pullRequest === Number(number) && entry.text === text,
  )?.kind;
};
