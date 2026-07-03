import { z } from "zod";
import type { WorkspaceRepo } from "@/lib/workspace-repos";

export const AGENT_TOOL_NAMES = [
  "todo",
  "read_file",
  "write_file",
  "grep",
  "glob",
  "bash",
  "web_fetch",
  "load_skill",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const agentToolNameSchema = z.enum(AGENT_TOOL_NAMES);
const nonEmptyStringSchema = z.string().trim().min(1);
const optionalStringSchema = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional();

const repoCoordinatePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9._/-]+$/;
const directoryPattern = /^[A-Za-z0-9._/-]+$/;

function isSafeDirectory(directory: string): boolean {
  return (
    directoryPattern.test(directory) &&
    !directory.startsWith("/") &&
    !directory.split("/").includes("..")
  );
}

function parseRepoString(value: string): WorkspaceRepo | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const [repoAndBranch, directoryRaw] = trimmed.split(":", 2);
  if (!repoAndBranch) {
    return null;
  }

  const [coordinate, branchRaw] = repoAndBranch.split("#", 2);
  if (!coordinate || !repoCoordinatePattern.test(coordinate)) {
    return null;
  }

  const [owner, repo] = coordinate.split("/");
  if (!owner || !repo) {
    return null;
  }

  const branch = branchRaw?.trim() || "main";
  if (!branchPattern.test(branch) || branch.includes("..")) {
    return null;
  }

  const directory = directoryRaw?.trim() || repo;
  if (!isSafeDirectory(directory)) {
    return null;
  }

  return {
    owner,
    repo,
    branch,
    directory,
    cloneUrl: `https://github.com/${owner}/${repo}`,
  };
}

const workspaceRepoSchema = z
  .preprocess(
    (value) => {
      if (typeof value === "string") {
        return parseRepoString(value);
      }
      return value;
    },
    z.object({
      owner: nonEmptyStringSchema,
      repo: nonEmptyStringSchema,
      branch: nonEmptyStringSchema.default("main"),
      directory: nonEmptyStringSchema.optional(),
      cloneUrl: nonEmptyStringSchema.optional(),
    }),
  )
  .refine((repo) => isSafeDirectory(repo.directory ?? repo.repo), {
    message: "Invalid workspace repo directory",
    path: ["directory"],
  })
  .transform((repo) => {
    const directory = repo.directory ?? repo.repo;

    return {
      owner: repo.owner,
      repo: repo.repo,
      branch: repo.branch,
      directory,
      cloneUrl: repo.cloneUrl ?? `https://github.com/${repo.owner}/${repo.repo}`,
    } satisfies WorkspaceRepo;
  });

const stringArraySchema = z
  .preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return [];
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return value;
  }, z.array(nonEmptyStringSchema))
  .default([]);

const toolArraySchema = z
  .preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return [];
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return value;
  }, z.array(agentToolNameSchema))
  .default([]);

export const agentFrontmatterSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    tools: toolArraySchema,
    skills: stringArraySchema,
    repos: z.preprocess(
      (value) => (value === undefined || value === null ? [] : value),
      z.array(workspaceRepoSchema),
    ),
    model: optionalStringSchema,
  })
  .transform((frontmatter) => {
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      tools: frontmatter.tools,
      skills: frontmatter.skills,
      repos: frontmatter.repos,
      model: frontmatter.model,
    };
  });

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export type AgentLibrarySaveScope = "user" | "group" | "org";
export type AgentLibraryItemScope = AgentLibrarySaveScope | "bundled";

export interface AgentDefinition {
  slug: string;
  name: string;
  description: string;
  tools: AgentToolName[];
  repos: WorkspaceRepo[];
  skills: string[];
  model?: string;
  systemPrompt: string;
  path: string;
  scope: AgentLibraryItemScope;
}

export const agentEditorInputSchema = z.object({
  slug: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  tools: z.array(agentToolNameSchema).default([]),
  repos: z.array(workspaceRepoSchema).default([]),
  skills: z.array(nonEmptyStringSchema).default([]),
  model: optionalStringSchema,
  systemPrompt: z.string().default(""),
});

export type AgentEditorInput = z.infer<typeof agentEditorInputSchema>;

export interface SkillDocument {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  scope: AgentLibraryItemScope;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  allowedTools?: string[];
  context?: "fork";
  agent?: string;
}

export const skillEditorInputSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  body: z.string().default(""),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  allowedTools: z.array(nonEmptyStringSchema).default([]),
  context: z.enum(["fork"]).optional(),
  agent: optionalStringSchema,
});

export type SkillEditorInput = z.infer<typeof skillEditorInputSchema>;

export interface AgentLibrarySummary {
  agents: AgentDefinition[];
  skills: SkillDocument[];
  defaultAgentName: string | null;
}

export interface AgentLibrarySaveResponse {
  library: AgentLibrarySummary;
  item: AgentDefinition | SkillDocument;
}
