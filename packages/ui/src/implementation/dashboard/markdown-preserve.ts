import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface Block {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const blocks = (markdown: string): readonly Block[] =>
  fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children.map((node) => {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? markdown.length;
    return { start, end, text: markdown.slice(start, end) };
  });

export const preserveMarkdown = (original: string, baseline: string, current: string): string => {
  if (current === baseline) return original;
  const source = blocks(original);
  const before = blocks(baseline);
  const after = blocks(current);
  if (source.length !== before.length || source.length === 0 || after.length === 0) return current;
  const matches = matchBlocks(before, after);
  const gap = (index: number) => {
    const left = matches[index - 1];
    const right = matches[index];
    const previous = after[index - 1];
    const next = after[index];
    if (left !== undefined && right !== undefined && right === left + 1)
      return original.slice(source[left]!.end, source[right]!.start);
    return current.slice(previous?.end ?? 0, next?.start ?? current.length);
  };
  let output = matches[0] === 0 ? original.slice(0, source[0]!.start) : gap(0);
  after.forEach((block, index) => {
    if (index > 0) output += gap(index);
    const match = matches[index];
    output += match === undefined ? block.text : source[match]!.text;
  });
  const last = matches[after.length - 1];
  return (
    output +
    (last === source.length - 1
      ? original.slice(source[last]!.end)
      : current.slice(after[after.length - 1]!.end))
  );
};

const matchBlocks = (before: readonly Block[], after: readonly Block[]) => {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * columns + j] =
        before[i]!.text === after[j]!.text
          ? table[(i + 1) * columns + j + 1]! + 1
          : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
  const matches: (number | undefined)[] = Array.from({ length: after.length });
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i]!.text === after[j]!.text) {
      matches[j] = i;
      i++;
      j++;
    } else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) i++;
    else j++;
  }
  return matches;
};
