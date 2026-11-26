export const fileGuards: Readonly<Record<string, ReadonlyArray<string>>> = {
  "packages/sdk/src/implementation/app-protocols.ts": [
    "app-package.spec.ts",
    "app-older-protocols.spec.ts",
  ],
  "packages/app-templates/executor/skills/executor/SKILL.md": [
    "framework-discovery.spec.ts",
    "cli-tool-commands.spec.ts",
  ],
  "packages/app-templates/executor/skills/executor/feedback.md": ["skill-read-telemetry.spec.ts"],
  "packages/app-templates/executor/skills/code-mode/SKILL.md": ["framework-discovery.spec.ts"],
  "packages/app-templates/executor/skills/app-authoring/SKILL.md": [
    "framework-discovery.spec.ts",
    "cli-tool-commands.spec.ts",
    "mcp-server.spec.ts",
    "local-skills.spec.ts",
  ],
  "packages/app-templates/executor/skills/app-authoring/ui.md": [
    "framework-discovery.spec.ts",
    "cli-tool-commands.spec.ts",
    "local-skills.spec.ts",
  ],
  "packages/app-templates/src/implementation/executor-intro.gen.ts": [
    "cli-tool-commands.spec.ts",
    "mcp-server.spec.ts",
  ],
};
