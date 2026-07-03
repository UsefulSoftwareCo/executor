import type { AutomationPolicy } from "./types";

export const AUTOMATION_AUTONOMY_LEVELS = [
  "read-only",
  "repo-edit",
  "branch-pr",
  "production",
] as const satisfies readonly AutomationPolicy["autonomy"][];

export const AUTONOMY_TOOL_ALLOWLIST: Record<AutomationPolicy["autonomy"], Set<string>> = {
  "read-only": new Set(["todo", "read_file", "grep", "glob"]),
  "repo-edit": new Set([
    "todo",
    "read_file",
    "write_file",
    "grep",
    "glob",
    "bash",
    "load_skill",
  ]),
  "branch-pr": new Set([
    "todo",
    "read_file",
    "write_file",
    "grep",
    "glob",
    "bash",
    "load_skill",
    "web_fetch",
  ]),
  production: new Set([
    "todo",
    "read_file",
    "write_file",
    "grep",
    "glob",
    "bash",
    "load_skill",
    "web_fetch",
  ]),
};

export function getBuiltInToolAllowlistForAutonomy(
  autonomy: AutomationPolicy["autonomy"],
): Set<string> {
  return AUTONOMY_TOOL_ALLOWLIST[autonomy];
}

export function isBuiltInToolAllowedForAutonomy(
  autonomy: AutomationPolicy["autonomy"],
  tool: string,
): boolean {
  return AUTONOMY_TOOL_ALLOWLIST[autonomy].has(tool);
}

export function filterBuiltInToolsForAutomationPolicy(
  policy: AutomationPolicy,
): string[] {
  const allowed = getBuiltInToolAllowlistForAutonomy(policy.autonomy);
  return policy.builtInTools.filter((tool) => allowed.has(tool));
}

export function blockedBuiltInToolsForAutomationPolicy(
  policy: AutomationPolicy,
): string[] {
  const allowed = getBuiltInToolAllowlistForAutonomy(policy.autonomy);
  return policy.builtInTools.filter((tool) => !allowed.has(tool));
}
