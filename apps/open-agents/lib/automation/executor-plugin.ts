/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Executor tool handlers are Promise-returning adapters and report validation failures by rejection */
import { definePlugin, Effect } from "@executor-js/sdk/core";
import { parseAutomationDefinition } from "./types";
import type { AutomationDefinitionInput, AutomationEventInput } from "./types";

type ToolArgs = Record<string, unknown>;

type LineDiffEntry = {
  kind: "context" | "add" | "remove";
  text: string;
};

type AutomationPluginCtx = {
  readonly owner: {
    readonly subject: string | null;
  };
};

function getExecutorUserId(ctx: AutomationPluginCtx): string {
  return ctx.owner.subject!;
}

function asRecord(value: unknown): ToolArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ToolArgs)
    : {};
}

function requireString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function requireDefinition(args: ToolArgs): AutomationDefinitionInput {
  const value = args.definition;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("definition is required");
  }
  return value as AutomationDefinitionInput;
}

function stringifyDefinition(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function buildLineDiff(beforeText: string, afterText: string): LineDiffEntry[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] =
        before[left] === after[right]
          ? lengths[left + 1][right + 1] + 1
          : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const diff: LineDiffEntry[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      diff.push({ kind: "context", text: before[left] ?? "" });
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      diff.push({ kind: "remove", text: before[left] ?? "" });
      left += 1;
    } else {
      diff.push({ kind: "add", text: after[right] ?? "" });
      right += 1;
    }
  }
  while (left < before.length) {
    diff.push({ kind: "remove", text: before[left] ?? "" });
    left += 1;
  }
  while (right < after.length) {
    diff.push({ kind: "add", text: after[right] ?? "" });
    right += 1;
  }
  return diff;
}

export const openAgentsAutomationPlugin = definePlugin(() => ({
  id: "open-agents-automations" as const,
  packageName: "@open-agents/web/automation-tools",
  storage: () => ({}),
  staticSources: () => [
    {
      id: "open_agents_automations",
      kind: "open-agents",
      name: "Open Agents Automations",
      tools: [
        {
          name: "list",
          description:
            "List Open Agents automations visible to the current user, including current version and recent run counts.",
          handler: ({ ctx }) =>
            Effect.promise(async () => {
              const { listAutomationsForUser } = await import("./store");
              return listAutomationsForUser(getExecutorUserId(ctx));
            }),
        },
        {
          name: "get",
          description: "Get one automation definition, recent runs, state, and correlations.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { getAutomationForUser } = await import("./store");
              return getAutomationForUser({
                automationId: requireString(asRecord(args), "automationId"),
                userId: getExecutorUserId(ctx),
              });
            }),
        },
        {
          name: "save",
          description:
            "Create or update an automation definition. Pass { definition, changeSummary? }.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Create or update an automation definition",
          },
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { upsertAutomationDefinition } = await import("./store");
              const record = asRecord(args);
              return upsertAutomationDefinition({
                userId: getExecutorUserId(ctx),
                definition: requireDefinition(record),
                changeSummary:
                  typeof record.changeSummary === "string"
                    ? record.changeSummary
                    : "Executor tool update",
              });
            }),
        },
        {
          name: "createDraft",
          description:
            "Create a disabled automation draft from { definition, changeSummary? } without enabling it.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { upsertAutomationDefinition } = await import("./store");
              const record = asRecord(args);
              return upsertAutomationDefinition({
                userId: getExecutorUserId(ctx),
                definition: {
                  ...requireDefinition(record),
                  enabled: false,
                },
                changeSummary:
                  typeof record.changeSummary === "string"
                    ? record.changeSummary
                    : "Executor draft creation",
              });
            }),
        },
        {
          name: "updateDraft",
          description:
            "Update an existing automation as a disabled draft. Pass { automationId, definition, changeSummary? }.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { upsertAutomationDefinition } = await import("./store");
              const record = asRecord(args);
              const automationId = requireString(record, "automationId");
              return upsertAutomationDefinition({
                userId: getExecutorUserId(ctx),
                definition: {
                  ...requireDefinition(record),
                  id: automationId,
                  enabled: false,
                },
                changeSummary:
                  typeof record.changeSummary === "string"
                    ? record.changeSummary
                    : "Executor draft update",
              });
            }),
        },
        {
          name: "diff",
          description:
            "Compare the current automation definition to a proposed definition. Pass { automationId, definition }.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { getAutomationForUser } = await import("./store");
              const record = asRecord(args);
              const automationId = requireString(record, "automationId");
              const current = await getAutomationForUser({
                automationId,
                userId: getExecutorUserId(ctx),
              });
              if (!current?.version) {
                throw new Error("Automation not found");
              }
              const currentText = stringifyDefinition(current.version.definitionJson);
              const proposed = {
                ...requireDefinition(record),
                id: automationId,
              };
              const proposedText = stringifyDefinition(proposed);
              const diff = buildLineDiff(currentText, proposedText);
              return {
                automationId,
                changed: currentText !== proposedText,
                current: current.version.definitionJson,
                proposed,
                diff,
                summary: {
                  additions: diff.filter((entry) => entry.kind === "add").length,
                  removals: diff.filter((entry) => entry.kind === "remove").length,
                },
              };
            }),
        },
        {
          name: "test",
          description:
            "Dry-run trigger, condition, policy, and action matching by default. Pass { automationId, event?, dryRun? }.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const record = asRecord(args);
              const automationId = requireString(record, "automationId");
              const userId = getExecutorUserId(ctx);
              const { getAutomationForUser } = await import("./store");
              const automation = await getAutomationForUser({ automationId, userId });
              if (!automation?.version) {
                throw new Error("Automation not found");
              }
              const definition = parseAutomationDefinition(
                automation.version.definitionJson,
              );
              const { buildAutomationTestEventInput } = await import("./test-event");
              const event = buildAutomationTestEventInput({
                automationId,
                userId,
                definition,
                body: record.event ?? record,
                dedupePrefix: "tool-test",
              });
              if (record.dryRun !== false) {
                const { buildAutomationDryRunPreview } = await import("./preview");
                return {
                  dryRun: true,
                  preview: await buildAutomationDryRunPreview({
                    automationId,
                    definition,
                    event,
                    userId,
                  }),
                };
              }
              const { emitAndRouteAutomationEvent } = await import("./dispatch");
              return emitAndRouteAutomationEvent(event);
            }),
        },
        {
          name: "enable",
          description: "Enable an automation after approval. Pass { automationId }.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Enable an automation",
          },
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { getAutomationForUser, upsertAutomationDefinition } =
                await import("./store");
              const automationId = requireString(asRecord(args), "automationId");
              const userId = getExecutorUserId(ctx);
              const current = await getAutomationForUser({ automationId, userId });
              if (!current?.version) {
                throw new Error("Automation not found");
              }
              const definition = parseAutomationDefinition(
                current.version.definitionJson,
              );
              return upsertAutomationDefinition({
                userId,
                definition: {
                  ...definition,
                  id: automationId,
                  enabled: true,
                },
                changeSummary: "Executor enabled automation",
              });
            }),
        },
        {
          name: "disable",
          description: "Disable an automation after approval. Pass { automationId }.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Disable an automation",
          },
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { getAutomationForUser, upsertAutomationDefinition } =
                await import("./store");
              const automationId = requireString(asRecord(args), "automationId");
              const userId = getExecutorUserId(ctx);
              const current = await getAutomationForUser({ automationId, userId });
              if (!current?.version) {
                throw new Error("Automation not found");
              }
              const definition = parseAutomationDefinition(
                current.version.definitionJson,
              );
              return upsertAutomationDefinition({
                userId,
                definition: {
                  ...definition,
                  id: automationId,
                  enabled: false,
                },
                changeSummary: "Executor disabled automation",
              });
            }),
        },
        {
          name: "emitEvent",
          description:
            "Emit an automation event and start the durable router workflow. Pass { event }.",
          handler: ({ args }) =>
            Effect.promise(async () => {
              const { emitAndRouteAutomationEvent } = await import("./dispatch");
              const record = asRecord(args);
              if (!record.event) {
                throw new Error("event is required");
              }
              return emitAndRouteAutomationEvent(record.event as AutomationEventInput);
            }),
        },
        {
          name: "listRuns",
          description: "List recent runs for one automation. Pass { automationId }.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { getAutomationForUser } = await import("./store");
              const automation = await getAutomationForUser({
                automationId: requireString(asRecord(args), "automationId"),
                userId: getExecutorUserId(ctx),
              });
              if (!automation) {
                throw new Error("Automation not found");
              }
              return automation.runs;
            }),
        },
        {
          name: "getRun",
          description: "Get a run with timeline, artifacts, approvals, and outbox entries.",
          handler: ({ args, ctx }) =>
            Effect.promise(async () => {
              const { getAutomationRunForUser } = await import("./store");
              return getAutomationRunForUser({
                runId: requireString(asRecord(args), "runId"),
                userId: getExecutorUserId(ctx),
              });
            }),
        },
        {
          name: "pollLinearIssues",
          description:
            "Poll Linear for recently updated issues and return automation events for a poll trigger evaluator. Intended for the built-in Linear polling source automation.",
          handler: ({ args }) =>
            Effect.promise(async () => {
              const { pollLinearIssuesForAutomation } = await import(
                "@/lib/linear/polling"
              );
              const record = asRecord(args);
              return pollLinearIssuesForAutomation({
                state: record.state,
                now: typeof record.now === "string" ? record.now : undefined,
                scope: record.scope,
              });
            }),
        },
      ],
    },
  ],
}));
