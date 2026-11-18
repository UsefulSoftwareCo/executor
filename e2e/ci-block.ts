/**
 * How a pull request description's `e2e` block is read: by CI's `select` job (e2e/ci-selection.ts)
 * and by `bun run pr:check` (scripts/pr-check.ts) for the layers of a stack it cannot check out.
 */

/** The trimmed text of each `e2e` block in a description. */
export const blocksIn = (body: string) =>
  [...body.matchAll(/^```e2e[ \t]*\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]!.trim());

/** What the description's e2e block asks for, parsed once for both the wait and the selection. */
export type Requested =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Several" }
  | { readonly _tag: "AllWithoutReason" }
  | { readonly _tag: "All"; readonly reason: string }
  | { readonly _tag: "Skip" }
  | { readonly _tag: "Named"; readonly tokens: ReadonlyArray<string> };

/** The full suite with its reason, `skip`, or the names written in the single `e2e` block. */
export const parseRequested = (body: string): Requested => {
  const blocks = blocksIn(body);
  if (blocks.length === 0) return { _tag: "Missing" };
  if (blocks.length > 1) return { _tag: "Several" };
  const text = blocks[0]!;
  const all = /^all\b:?\s*([\s\S]*)$/.exec(text);
  if (all !== null) {
    const reason = all[1]!.replace(/\s+/g, " ").trim();
    return reason === "" ? { _tag: "AllWithoutReason" } : { _tag: "All", reason };
  }
  const tokens = text.split(/[\s,]+/).filter((token) => token.length > 0);
  if (tokens.length === 1 && tokens[0] === "none") return { _tag: "Named", tokens: [] };
  if (tokens.length === 1 && tokens[0] === "skip") return { _tag: "Skip" };
  return { _tag: "Named", tokens };
};
