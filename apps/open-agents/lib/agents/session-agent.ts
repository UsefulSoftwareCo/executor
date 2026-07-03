import "server-only";

import path from "node:path";
import type { Sandbox } from "@open-agents/sandbox";
import type { SkillMetadata } from "@/lib/skills/types";
import type { AgentDefinition } from "./definitions";
import {
  getAgentDefinition,
  listLocalSkillFilesForPatterns,
  matchesAgentPattern,
} from "./repository";

export async function resolveSessionAgent(
  agentName: string | null | undefined,
  userId?: string,
): Promise<AgentDefinition | null> {
  if (!agentName) {
    return null;
  }

  return getAgentDefinition(agentName, userId);
}

export function filterSkillsForAgent(
  skills: SkillMetadata[],
  agent: AgentDefinition | null,
): SkillMetadata[] {
  if (!agent || agent.skills.length === 0) {
    return skills;
  }

  return skills.filter((skill) =>
    agent.skills.some((pattern) =>
      matchesAgentPattern(pattern, [
        skill.name,
        skill.relativePath ?? "",
        path.posix.basename(skill.path),
      ]),
    ),
  );
}

export function filterSkillsForPatterns(
  skills: SkillMetadata[],
  patterns: string[],
): SkillMetadata[] {
  if (patterns.length === 0) {
    return [];
  }

  return skills.filter((skill) =>
    patterns.some((pattern) =>
      matchesAgentPattern(pattern, [
        skill.name,
        skill.relativePath ?? "",
        path.posix.basename(skill.path),
      ]),
    ),
  );
}

export async function installLocalSkillsForPatterns(params: {
  sandbox: Sandbox;
  patterns: string[];
  userId?: string;
}): Promise<void> {
  if (params.patterns.length === 0) {
    return;
  }

  const skills = await listLocalSkillFilesForPatterns(params.patterns, params.userId);
  await Promise.all(
    skills.flatMap((skill) =>
      skill.files.map((file) =>
        params.sandbox.writeFile(
          path.posix.join(
            params.sandbox.workingDirectory,
            ".agents",
            "skills",
            file.relativePath,
          ),
          file.content,
          "utf-8",
        ),
      ),
    ),
  );
}

export async function installAgentLocalSkills(params: {
  sandbox: Sandbox;
  agent: AgentDefinition | null;
  didSetupWorkspace: boolean;
  userId?: string;
}): Promise<void> {
  if (!params.didSetupWorkspace || !params.agent || params.agent.skills.length === 0) {
    return;
  }

  await installLocalSkillsForPatterns({
    sandbox: params.sandbox,
    patterns: params.agent.skills,
    userId: params.userId,
  });
}

export function buildAgentCustomInstructions(agent: AgentDefinition | null): string | undefined {
  if (!agent) {
    return undefined;
  }

  const prompt = agent.systemPrompt.trim();
  if (!prompt) {
    return undefined;
  }

  return `# Agent Profile: ${agent.name}\n\n${prompt}`;
}
