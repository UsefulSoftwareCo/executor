import { Option } from "effect";

export interface GitHubSkillInput {
  readonly owner: string;
  readonly repository: string;
  readonly requestedRef: string | null;
  readonly directory: string;
  readonly selectedSkills: readonly string[];
}

const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const validSegment = (value: string | undefined): value is string =>
  value !== undefined && value !== "." && value !== ".." && segmentPattern.test(value);

const commandLocation = (
  input: string,
): { readonly location: string; readonly selectedSkills: readonly string[] } => {
  const ignored = new Set([
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
  const tokens = input.split(/\s+/).filter(Boolean);
  const selectedSkills: string[] = [];
  let location = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--skill" || token === "--skills" || token === "-s") {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        selectedSkills.push(...value.split(","));
        index += 1;
      }
      continue;
    }
    const inline = /^--skills?=(.+)$/.exec(token)?.[1];
    if (inline !== undefined) {
      selectedSkills.push(...inline.split(","));
      continue;
    }
    if (token.startsWith("-") || ignored.has(token.toLowerCase())) continue;
    if (location === "") location = token;
  }
  return {
    location: location.replace(/^['"]|['"]$/g, ""),
    selectedSkills: selectedSkills.map((name) => name.trim()).filter(Boolean),
  };
};

export const parseGitHubSkillInput = (input: string): Option.Option<GitHubSkillInput> => {
  const parsed = commandLocation(input.trim());
  if (parsed.location === "") return Option.none();
  let segments: string[];
  let hosted = false;
  const first = parsed.location.split("/")[0]?.toLowerCase() ?? "";
  const shorthand =
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(\/|$)/.test(parsed.location) &&
    !parsed.location.includes("://") &&
    !first.includes(".");
  if (shorthand) {
    segments = parsed.location.split("?")[0]?.split("/") ?? [];
  } else {
    const withScheme = /^[a-z]+:\/\//i.test(parsed.location)
      ? parsed.location
      : `https://${parsed.location}`;
    const result = Option.liftThrowable((value: string) => new URL(value))(withScheme);
    if (Option.isNone(result)) return Option.none();
    const host = result.value.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "github.com" && host !== "skills.sh") return Option.none();
    hosted = true;
    segments = result.value.pathname.split("/").slice(1);
  }

  const [owner, rawRepository, ...rest] = segments;
  const repository = rawRepository?.replace(/\.git$/, "");
  if (!validSegment(owner) || !validSegment(repository)) return Option.none();
  let requestedRef: string | null = null;
  let directorySegments = rest;
  if (hosted && (rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) {
    requestedRef = rest[1] ?? null;
    directorySegments = rest.slice(2);
    if (rest[0] === "blob" && directorySegments.at(-1) === "SKILL.md") {
      directorySegments = directorySegments.slice(0, -1);
    }
  }
  if (directorySegments.some((segment) => segment === "." || segment === "..")) {
    return Option.none();
  }
  return Option.some({
    owner,
    repository,
    requestedRef,
    directory: directorySegments.filter(Boolean).join("/"),
    selectedSkills: parsed.selectedSkills,
  });
};
