/** Suggestions for a tool path that names no tool. Search ranking runs in the SDK. */

/** Levenshtein distance between two strings. */
const distance = (left: string, right: string) => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length]!;
};

/** The `limit` candidates fewest edits from `name`, nearest first; ties keep candidate order. */
export const nearest = (name: string, candidates: ReadonlyArray<string>, limit: number) =>
  candidates
    .map((candidate, index) => ({ candidate, index, edits: distance(name, candidate) }))
    .sort((left, right) => left.edits - right.edits || left.index - right.index)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
