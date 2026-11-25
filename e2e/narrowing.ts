import { matchesPath } from "./mcp-search-guard.ts";

export interface Narrowing {
  readonly holds: string;
  readonly paths: ReadonlyArray<string>;
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

export const narrowingOf = (file: string) =>
  narrowings.find((entry) => entry.paths.some((path) => matchesPath(path, file)));

export const broadChanges = (files: ReadonlyArray<string>) =>
  files.filter((file) => narrowingOf(file) === undefined);
