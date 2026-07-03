import path from "node:path";
import type { Sandbox } from "@open-agents/sandbox";

type BundledSkillFile = {
  relativePath: string;
  content: string;
};

const AUGMENT_VOI_TRIAGE_SKILL: BundledSkillFile[] = [
  {
    relativePath: "augment-voi-triage/SKILL.md",
    content: `---
name: augment-voi-triage
description: Triage Augment VOI voice investigations across augment-web, augment-services, and augment-voice. Use when investigating VOI issues, voice triage tickets, carrier selection workflows, prompt regressions, call analysis, or cross-repo Augment voice behavior.
---

# Augment VOI Triage

Use this skill for first-pass triage and high-confidence fixes for VOI investigations started from Linear or Slack hooks. Hook-started VOI sessions are triage-first: do not build broad features by default.

## Workspace

The workspace is a metarepo with these sibling repositories:

- \`augment-web\`: customer portal and workflow authoring UI. Default branch: \`staging\`.
- \`augment-services\`: service APIs, agent registry, track-and-trace service code, database models, and migrations. Default branch: \`main\`.
- \`augment-voice\`: voice runtime, LiveKit integration, prompts, prompt regression tests, call handling, and voice API code. Default branch: \`main\`.

## Triage Loop

1. Read the source issue or message fully and extract concrete evidence: issue identifier, linked PRs, call IDs, load IDs, brokerage/customer names, expected behavior, actual behavior, timestamps, and repro notes.
2. Classify likely ownership, but search all three repos before deciding. UI/workflow authoring issues usually start in \`augment-web\`; API, registry, data model, migrations, and track-and-trace service issues usually start in \`augment-services\`; voice runtime, prompts, prompt evals, LiveKit, call analysis, and transcript behavior usually start in \`augment-voice\`.
3. Find precedent before editing. Search for the Linear identifier, related PRs, nearby tests, prompt eval YAMLs, call-analysis code, workflow builder components, and any TODOs around the failing behavior.
4. State a root-cause hypothesis only when tied to code or test evidence. If evidence is missing, say what is missing and where to get it.
5. For a high-confidence fix, make the smallest focused change and add a regression test in the repo that owns the behavior. If the ticket requires product decisions, a new UI flow, a schema/API contract, or a multi-file feature, stop after the triage report and fix plan.
6. Run focused checks from the owning repo. Prefer the repo package scripts and local conventions. Report commands and outcomes.

## Fix Patterns

- Prompt behavior in \`augment-voice\`: add or update prompt regression YAMLs before changing prompt sections. Run the focused prompt eval or pytest command used by nearby tests.
- Voice runtime bugs in \`augment-voice\`: inspect lifecycle wiring, constructor paths, empty-response handling, interruption behavior, and LiveKit/tool call interactions. Unit tests that bypass constructors are not enough.
- Portal workflow bugs in \`augment-web\`: inspect route loaders/actions, workflow builder hooks, generated agent payloads, and customer-visible permissions. Add colocated utests where nearby files already use them.
- Service or schema work in \`augment-services\`: inspect API contracts, generated clients, package boundaries, migrations, and deployment order. If schema changes are needed, include migration steps and deployment notes.

## Response Shape

Return a concise triage report with:

- Likely owning repo or repos.
- Root cause or strongest hypothesis.
- Evidence found, with file paths and test or ticket references.
- Proposed fix or implemented change.
- Verification commands and results.
- Open questions or missing data, if any.
`,
  },
  {
    relativePath: "augment-voi-triage/references/repo-map.md",
    content: `# Augment VOI Repository Map

## augment-web

Portal and workflow authoring UI. Recent VOI fixes here involved carrier selection workflow visibility, blank voice-agent creation from custom workflow builders, and resource-route payload handling.

## augment-services

Service APIs, agent registry, content tables, track-and-trace agent service code, and database migrations. Recent VOI fixes here included track-and-trace initial greeting payload construction and agent-registry content-table schemas.

## augment-voice

Voice runtime, prompt sections, prompt regression tests, LiveKit behavior, transcript/call handling, and voice API v2. Recent VOI fixes here included CS call response stalls, repeated questions, interruption handling, ETA/date extraction, and prompt regressions for carrier availability.

## Cross-Repo Rule

When unsure, inspect all three. Many VOI tickets start as product symptoms but resolve in a different layer than the initial report suggests.
`,
  },
];

const BUNDLED_TRIAGE_SKILLS = [AUGMENT_VOI_TRIAGE_SKILL];

export async function installBundledTriageSkills(params: {
  sandbox: Sandbox;
}): Promise<void> {
  for (const skill of BUNDLED_TRIAGE_SKILLS) {
    for (const file of skill) {
      await params.sandbox.writeFile(
        path.posix.join(
          params.sandbox.workingDirectory,
          ".agents",
          "skills",
          file.relativePath,
        ),
        file.content,
        "utf-8",
      );
    }
  }
}
