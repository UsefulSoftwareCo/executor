import type { AutomationDefinition } from "./types";

type AgentSpec = AutomationDefinition["agent"];

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

export function extractAgentSkillPatterns(agent: AgentSpec | undefined): string[] {
  if (!agent) {
    return [];
  }
  if (agent.kind === "inline") {
    return readStringArray(agent.definition.skills);
  }
  if (agent.kind === "extend") {
    return readStringArray(agent.override.skills);
  }
  return [];
}

export function resolveAgentReference(agent: AgentSpec | undefined): string | null {
  if (!agent) {
    return null;
  }
  if (agent.kind === "preset") {
    return agent.name;
  }
  if (agent.kind === "extend") {
    return agent.base;
  }
  return null;
}

