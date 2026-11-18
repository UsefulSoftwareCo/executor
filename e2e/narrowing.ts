/**
 * The changes that may run a selection instead of the full suite once a pull request is ready for
 * review (e2e/ci-selection.ts).
 *
 * A draft runs the spec files its `e2e` block names, as before, so an author gets an answer in
 * minutes. A pull request that is ready for review and changes anything outside this table runs
 * every scenario: nothing ties a source file to the scenarios that cover it, and a selection that
 * missed one has turned main red after merge (a change to the SDK's tool code, selected with one
 * spec file, failed an OAuth refresh scenario on main). Marking a pull request ready therefore
 * starts the full suite on its head, and the merge waits for it.
 *
 * Each entry names paths whose changes no scenario runs through, and what runs for them instead.
 * The comparison is everything the pull request changes since main, so a stack's top layer answers
 * for every layer below it: a tests layer above a code layer runs the full suite.
 *
 * Paths ending in `/` match everything below them; others match one file, `*` standing for any
 * part of a name. A path that names nothing in the tree fails a case in
 * e2e/tests/ci-selection.spec.ts, so the table cannot keep entries for files that moved.
 */
import { matchesPath } from "./mcp-search-guard.ts";

export interface Narrowing {
  /** What these paths hold. */
  readonly holds: string;
  readonly paths: ReadonlyArray<string>;
  /** What a ready pull request that changes only these runs, and why that is enough. */
  readonly runs: string;
}

export const narrowings: ReadonlyArray<Narrowing> = [
  {
    holds: "notes and plans for people and agents",
    paths: ["notes/", "plans/"],
    runs: "the e2e block's selection: no product code, build or scenario reads them",
  },
  {
    holds: "the repository's own documents and agent skills",
    paths: [
      "README.md",
      "CONTEXT.md",
      "DEVELOPMENT.md",
      "RELEASING.md",
      "SECURITY.md",
      "AGENTS.md",
      ".agents/",
    ],
    runs: "the e2e block's selection: no product code, build or scenario reads them",
  },
  {
    holds: "spec files",
    paths: ["e2e/tests/*.spec.ts"],
    runs: "every changed spec file, which a pull request always runs, and the e2e block's selection",
  },
];

/** The table entry a file falls under, or undefined for product source and everything else. */
export const narrowingOf = (file: string) =>
  narrowings.find((entry) => entry.paths.some((path) => matchesPath(path, file)));

/** The files in `files` that no entry narrows: each one makes a ready pull request run everything. */
export const broadChanges = (files: ReadonlyArray<string>) =>
  files.filter((file) => narrowingOf(file) === undefined);
