// ---------------------------------------------------------------------------
// Where a skill comes from when it is imported by URL.
//
// Every public skill registry today (skills.sh, `npx skills`, `gh skill`,
// skillshare) is GitHub underneath, so one resolver covers them all: a repo,
// an optional ref, and an optional path inside it. The resolver is pure — it
// turns the strings a user pastes into a `GitHubSkillSource` — and the fetch
// lives beside the HTTP handler that needs a network.
// ---------------------------------------------------------------------------

import { Option } from "effect";

export interface GitHubSkillSource {
  readonly owner: string;
  readonly repo: string;
  /** Branch, tag, or commit. Absent means the repository's default branch. */
  readonly ref: string | null;
  /** Directory inside the repo to scan, `""` for the root. */
  readonly path: string;
  /** Only skills with these names, when the input named some (`--skill x`).
   *  Empty means every skill found. */
  readonly skills: readonly string[];
}

const GITHUB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const isSegment = (value: string | undefined): value is string =>
  value !== undefined && GITHUB_SEGMENT.test(value) && value !== "." && value !== "..";

const cleanRepo = (repo: string): string => repo.replace(/\.git$/, "");

const cleanPath = (segments: readonly string[]): string =>
  segments.filter((segment) => segment !== "").join("/");

/**
 * Parse what a user pastes into a GitHub source.
 *
 * Accepted forms, all with optional `.git`, trailing slash, and query string:
 *
 *   owner/repo
 *   owner/repo/path/to/skill
 *   github.com/owner/repo[/tree/<ref>/path]
 *   https://github.com/owner/repo[/tree/<ref>/path | /blob/<ref>/path/SKILL.md]
 *   https://skills.sh/owner/repo[/skill-name]
 *
 * A `blob` link to a SKILL.md resolves to the directory that holds it. Anything
 * else — another host, an owner-only URL, a path with `..` — is `None`, and the
 * caller tells the user what is accepted rather than guessing.
 */
/**
 * Pull the location and any `--skill` names out of a pasted install command.
 *
 * skills.sh shows `npx skills add <source> --skill <name>`; `gh skill install`,
 * `skillshare install`, and `bunx`/`pnpx` variants have the same shape. The
 * location is the first token that is not a command word or a flag; every
 * `--skill`/`-s` value (space- or `=`-separated, comma lists allowed) narrows
 * the import to those names.
 */
const splitCommand = (
  input: string,
): { readonly location: string; readonly skills: readonly string[] } => {
  const tokens = input.split(/\s+/).filter((token) => token !== "");
  const commandWords = new Set([
    "npx",
    "bunx",
    "pnpx",
    "pnpm",
    "yarn",
    "bun",
    "npm",
    "dlx",
    "x",
    "skills",
    "skill",
    "skillshare",
    "gh",
    "add",
    "install",
    "i",
    "-y",
    "--yes",
  ]);
  const skills: string[] = [];
  let location: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--skill" || token === "-s" || token === "--skills") {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        skills.push(...value.split(","));
        index += 1;
      }
      continue;
    }
    const inline = /^--skills?=(.+)$/.exec(token);
    if (inline?.[1]) {
      skills.push(...inline[1].split(","));
      continue;
    }
    if (token.startsWith("-")) continue;
    if (commandWords.has(token.toLowerCase())) continue;
    if (location === null) location = token;
  }
  return {
    location: location ?? "",
    skills: skills.map((name) => name.trim()).filter((name) => name !== ""),
  };
};

export const parseGitHubSkillSource = (input: string): Option.Option<GitHubSkillSource> => {
  const { location, skills } = splitCommand(input.trim());
  const trimmed = location.replace(/^["']|["']$/g, "");
  if (trimmed === "") return Option.none();

  let segments: string[];
  let viaHost = false;
  const firstSegment = trimmed.split("/")[0]?.toLowerCase() ?? "";
  const looksLikeHost = firstSegment.includes(".") && !trimmed.includes("://");
  if (
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(\/|$)/.test(trimmed) &&
    !trimmed.includes("://") &&
    !looksLikeHost
  ) {
    // `owner/repo[/path]` shorthand — the form every skills CLI accepts.
    segments = trimmed.split("?")[0]?.split("/") ?? [];
  } else {
    const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL parsing throws on malformed input; None is the honest answer
    try {
      url = new URL(withScheme);
    } catch {
      return Option.none();
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "github.com" && host !== "skills.sh") return Option.none();
    viaHost = true;
    segments = url.pathname.split("/").slice(1);
  }

  const [owner, repoRaw, ...rest] = segments;
  if (!isSegment(owner) || repoRaw === undefined) return Option.none();
  const repo = cleanRepo(repoRaw);
  if (!isSegment(repo)) return Option.none();

  // GitHub's `tree`/`blob` URLs carry the ref as the next segment; a bare
  // shorthand carries no ref and the rest is the path.
  let ref: string | null = null;
  let pathSegments = rest;
  if (viaHost && (rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) {
    const kind = rest[0];
    ref = rest[1] ?? null;
    pathSegments = rest.slice(2);
    if (kind === "blob" && pathSegments[pathSegments.length - 1] === "SKILL.md") {
      pathSegments = pathSegments.slice(0, -1);
    }
  }
  if (pathSegments.some((segment) => segment === "." || segment === "..")) return Option.none();
  return Option.some({ owner, repo, ref, path: cleanPath(pathSegments), skills });
};

/** The canonical `owner/repo[@ref][/path]` label for a resolved source. */
export const formatGitHubSkillSource = (source: GitHubSkillSource): string =>
  `${source.owner}/${source.repo}${source.ref ? `@${source.ref}` : ""}${source.path ? `/${source.path}` : ""}`;
