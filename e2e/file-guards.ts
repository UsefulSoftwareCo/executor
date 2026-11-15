/**
 * Scenarios that assert a contract one file states in full, by that file (e2e/ci-selection.ts).
 * When a guarded file's contents differ from main's, its spec files run, whatever the pull request's
 * `e2e` block names. The comparison is with main, not with the layer below, so the top of a stack
 * runs them when any lower layer changes the file: a long stack whose base edits one of these runs
 * them on every tested layer, which is the guard doing its job, not a cost to optimise away.
 *
 * Add a file here when a scenario reads its text back, with the spec files that do: the cases in
 * e2e/tests/ci-selection.spec.ts check that each file exists and each spec file runs on a pull
 * request.
 */
export const fileGuards: Readonly<Record<string, ReadonlyArray<string>>> = {
  // app-package.spec.ts reads back every protocol the host supports when it rejects an unsupported
  // framework, so a new protocol changes its expected message.
  "packages/sdk/src/implementation/app-protocols.ts": [
    "app-package.spec.ts",
    "app-older-protocols.spec.ts",
  ],
  // The Executor app's skill texts, which scenarios read back through the skills tool and the CLI.
  // The entry skill names the deeper skills to read.
  "packages/app-templates/executor/skills/executor/SKILL.md": [
    "framework-discovery.spec.ts",
    "cli-tool-commands.spec.ts",
  ],
  "packages/app-templates/executor/skills/executor/feedback.md": ["skill-read-telemetry.spec.ts"],
  // Where images and audio are explained.
  "packages/app-templates/executor/skills/code-mode/SKILL.md": ["framework-discovery.spec.ts"],
  // The authoring guide's heading and its table of topics.
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
  // The MCP server's instructions, generated from the entry skill.
  "packages/app-templates/src/implementation/executor-intro.gen.ts": [
    "cli-tool-commands.spec.ts",
    "mcp-server.spec.ts",
  ],
};
