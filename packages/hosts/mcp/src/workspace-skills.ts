// ---------------------------------------------------------------------------
// Workspace skills on the MCP surface.
//
// A workspace skill is an Agent Skill (a SKILL.md directory, see
// https://agentskills.io) saved to Executor by a user, personally or for the
// whole org. Every agent connected to this server should be able to find and
// load it, so it is served two ways:
//
//   1. Through the `skills` tool, alongside Executor's own how-to docs. Every
//      MCP client can call a tool today, so this is the channel that works
//      everywhere. The tool description carries the catalog (name + description)
//      so the model knows what exists before it asks.
//   2. Through the MCP Skills Extension (SEP-2640): the server declares
//      `io.modelcontextprotocol/skills`, answers `skills/list` and `skills/get`
//      with digest manifests, and serves every file as a `skill://` resource.
//      Clients that adopt the standard pick skills up with no tool call at all.
//
// Both channels read the same live source (`executor.skills`), so a skill saved
// in the console is visible to an already-connected agent on its next call.
// ---------------------------------------------------------------------------

import { Effect, Option } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  parseSkillUri,
  skillBody,
  skillFileUri,
  SKILL_MD_PATH,
  type Owner,
  type Skill,
  type SkillFileEntry,
  type SkillRef,
  type SkillSummary,
} from "@executor-js/sdk";

/**
 * The two reads this surface needs. Structurally satisfied by
 * `executor.skills`; hosts pass that so the whole `Executor` never crosses this
 * boundary. Both are LIVE: nothing here caches skill content.
 */
export type McpSkillsPort = {
  readonly list: () => Effect.Effect<readonly SkillSummary[], unknown>;
  readonly get: (ref: SkillRef) => Effect.Effect<Skill, unknown>;
};

/** The extension id SEP-2640 assigns, as it appears under `capabilities.extensions`. */
export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** How a workspace skill is referred to in the `skills` tool: `owner/name`. */
export const workspaceSkillLabel = (ref: SkillRef): string => `${ref.owner}/${ref.name}`;

/**
 * Resolve what the model typed into one workspace skill.
 *
 * Accepts the bare `name` or the explicit `owner/name`. A bare name that exists
 * both personally and for the org resolves to the personal one: that is the
 * same shadowing rule local skill directories use (the nearer scope wins), and
 * the explicit form is always there to reach the other.
 */
export const resolveWorkspaceSkill = (
  input: string,
  skills: readonly SkillSummary[],
): SkillSummary | undefined => {
  const slash = input.indexOf("/");
  if (slash !== -1) {
    const owner = input.slice(0, slash);
    const name = input.slice(slash + 1);
    return skills.find((skill) => skill.owner === owner && skill.name === name);
  }
  const matches = skills.filter((skill) => skill.name === input);
  return matches.find((skill) => skill.owner === "user") ?? matches[0];
};

// ---------------------------------------------------------------------------
// Rendering for the `skills` tool
// ---------------------------------------------------------------------------

const ownerWord = (owner: Owner): string => (owner === "org" ? "workspace" : "personal");

/** One-line catalog entry, the shape both the index and the description use. */
const catalogLine = (skill: SkillSummary): string =>
  `- \`${skill.name}\` (${ownerWord(skill.owner)}) — ${skill.description}`;

/** How many workspace skills the tool description names before it truncates.
 *  The description is loaded into every session's prompt, so it stays bounded
 *  no matter how many skills a workspace saves; the index is the full list. */
export const SKILL_CATALOG_DESCRIPTION_LIMIT = 40;

/**
 * The `skills` tool description when workspace skills can be served. Replaces
 * the docs-only wording: this IS now a skill reader for the skills saved in
 * Executor, and it says so, while still marking the boundary for skills that
 * live on the agent's own disk (which it still cannot reach).
 */
export const renderSkillsToolDescription = (skills: readonly SkillSummary[]): string => {
  const shown = skills.slice(0, SKILL_CATALOG_DESCRIPTION_LIMIT);
  const hidden = skills.length - shown.length;
  const catalog =
    skills.length === 0
      ? ["No workspace skills are saved yet; the catalog below is Executor's docs only."]
      : [
          "Skills saved in this Executor workspace — load one when a task matches its description:",
          ...shown.map(catalogLine),
          ...(hidden > 0 ? [`- …and ${hidden} more; call with no name for the full index.`] : []),
        ];
  return [
    "Skills for THIS server: Executor's own how-to docs (`execute`, artifacts) plus the Agent Skills saved in this Executor workspace. It cannot reach a SKILL.md on your own disk or your harness's skills — only what is listed here.",
    'Call `skills({ name: "<name>" })` to load a skill\'s instructions; the result lists its bundled files, which you read with `skills({ name, file: "<path>" })`. A name that exists both personally and for the workspace resolves to the personal one; use `owner/name` (`org/<name>` or `user/<name>`) to be explicit.',
    'Call `skills({ name: "execute" })` for the full guide to writing code for the `execute` tool. Call with no name to list everything.',
    "",
    ...catalog,
  ].join("\n");
};

/** The workspace section appended to the `skills` index. */
export const renderWorkspaceSkillsIndex = (skills: readonly SkillSummary[]): string =>
  skills.length === 0
    ? "No skills are saved in this Executor workspace yet. Add one in the console under Skills and it appears here for every connected agent."
    : [
        'Skills saved in this Executor workspace. Load one with `skills({ name: "<name>" })`; read a bundled file with `skills({ name, file: "<path>" })`.',
        "",
        ...skills.map(catalogLine),
      ].join("\n");

const bundledFiles = (skill: Skill): readonly SkillFileEntry[] =>
  skill.files.filter((file) => file.path !== SKILL_MD_PATH);

/**
 * What the model receives when it loads a workspace skill: the SKILL.md body
 * with the frontmatter stripped (name and description were already in the
 * catalog), wrapped in identifying tags, followed by the list of bundled files
 * and how to read one. The files themselves are NOT inlined — that is the
 * progressive disclosure the standard asks for.
 */
export const renderWorkspaceSkill = (skill: Skill): string => {
  const files = bundledFiles(skill);
  const resources =
    files.length === 0
      ? []
      : [
          "",
          "<skill_resources>",
          ...files.map((file) => `  <file>${file.path}</file>`),
          "</skill_resources>",
          `Read a bundled file with \`skills({ name: "${workspaceSkillLabel(skill)}", file: "<path>" })\`. Relative paths in the instructions above are relative to the skill's root.`,
        ];
  return [
    `<skill_content name="${skill.name}" owner="${skill.owner}">`,
    skillBody(skill),
    ...resources,
    "</skill_content>",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// MCP Skills Extension (SEP-2640)
// ---------------------------------------------------------------------------

/** MIME type for a skill file, by extension. Markdown is what the standard is
 *  made of; everything else is served as plain text. */
export const skillFileMimeType = (path: string): string =>
  path.endsWith(".md") ? "text/markdown" : "text/plain";

/** One `skills/list` / `skills/get` entry: the SKILL.md URI, the verbatim
 *  frontmatter, and the complete digest manifest. */
export const skillEntry = (skill: SkillSummary) => ({
  uri: skillFileUri(skill, SKILL_MD_PATH),
  frontmatter: skill.frontmatter,
  resources: skill.files.map((file) => ({
    uri: skillFileUri(skill, file.path),
    digest: file.digest,
    size: file.size,
  })),
});

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).loose().optional(),
});

const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }).loose(),
});

const SKILL_RESOURCE_TEMPLATE = "skill://{owner}/{name}/{+path}";

/** Runs an Effect at an SDK callback edge with the server's captured context. */
export type RunAtEdge = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;

/**
 * Register the extension's methods and the `skill://` resource space on a
 * server that has already declared the `resources` capability and the
 * extension under `capabilities.extensions`.
 *
 * `skills/list` never paginates: a workspace's catalog is small by
 * construction (each entry is one saved row), and an unpaginated listing is
 * what every client handles.
 */
export const registerWorkspaceSkills = (
  server: McpServer,
  port: McpSkillsPort,
  run: RunAtEdge,
): void => {
  const list = () => run(port.list());
  // The SDK turns a thrown McpError into the JSON-RPC error the method
  // requires (-32602 for an unknown skill or file), so the not-found path is a
  // failed Effect run through the same edge as every other read.
  const notFound = (uri: string) =>
    run(
      Effect.fail(new McpError(ErrorCode.InvalidParams, `Unknown skill resource: ${uri}`)),
    ) as Promise<never>;

  server.server.setRequestHandler(SkillsListRequestSchema, async () => ({
    skills: (await list()).map(skillEntry),
  }));

  server.server.setRequestHandler(SkillsGetRequestSchema, async ({ params }) => {
    const parsed = parseSkillUri(params.uri);
    if (Option.isNone(parsed) || parsed.value.path !== SKILL_MD_PATH) return notFound(params.uri);
    const { owner, name } = parsed.value;
    const skill = (await list()).find((entry) => entry.owner === owner && entry.name === name);
    if (!skill) return notFound(params.uri);
    return { skill: skillEntry(skill) };
  });

  server.registerResource(
    "Workspace skills",
    new ResourceTemplate(SKILL_RESOURCE_TEMPLATE, {
      // `resources/list` shows one entry per skill — its SKILL.md — so a
      // resource browser sees the skills, not every bundled file.
      list: async () => ({
        resources: (await list()).map((skill) => ({
          uri: skillFileUri(skill, SKILL_MD_PATH),
          name: skill.name,
          description: skill.description,
          mimeType: skillFileMimeType(SKILL_MD_PATH),
        })),
      }),
    }),
    {
      description: "Agent Skills saved in this Executor workspace, one file per resource.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const href = uri.toString();
      const parsed = parseSkillUri(href);
      if (Option.isNone(parsed) || parsed.value.path === "") return notFound(href);
      const { owner, name, path } = parsed.value;
      const skill = await run(
        port.get({ owner, name }).pipe(Effect.catchCause(() => Effect.succeed(null))),
      );
      const file = skill?.files.find((entry) => entry.path === path);
      if (!file) return notFound(href);
      return {
        contents: [{ uri: href, mimeType: skillFileMimeType(path), text: file.content }],
      };
    },
  );
};
