import { z } from "zod";
import { AGENT_TOOL_NAMES } from "@/lib/agents/definitions";

export const resourceScopeKindSchema = z.enum(["user", "group", "org"]);
export const automationScopeKindSchema = resourceScopeKindSchema;
export const eventScopeKindSchema = resourceScopeKindSchema;

export const ownerKindSchema = z.enum(["user", "app-bot", "service-account"]);
export const trustSchema = z.enum(["internal", "partner", "public"]);

const jsonRecordSchema = z.record(z.string(), z.unknown());
const automationBuiltInToolSchema = z.enum(AGENT_TOOL_NAMES);

export const automationScopeSchema = z.object({
  kind: automationScopeKindSchema,
  id: z.string().min(1),
});

export const automationOwnerSchema = z.object({
  kind: ownerKindSchema,
  id: z.string().min(1),
});

export const automationIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("app-bot"), botId: z.string().min(1) }),
  z.object({
    kind: z.literal("service-account"),
    accountId: z.string().min(1),
  }),
]);

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("interval"),
    everyMs: z.number().int().positive(),
    anchorAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal("once"),
    dueAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1),
    timezone: z.string().optional(),
  }),
]);

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
    source: z.string().min(1).optional(),
    type: z.string().min(1),
    subject: jsonRecordSchema.optional(),
  }),
  z.object({
    kind: z.literal("schedule"),
    schedule: scheduleSchema,
  }),
  z.object({
    kind: z.literal("poll"),
    schedule: scheduleSchema,
    evaluator: z.object({
      code: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    }),
  }),
  z.object({ kind: z.literal("manual") }),
]);

export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("field"),
    path: z.string().min(1),
    op: z.enum(["eq", "contains", "matches", "in"]),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal("rate-limit"),
    key: z.string().min(1),
    max: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("function"),
    ref: z.object({
      code: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    }),
  }),
]);

export const concurrencyPolicySchema = z.object({
  key: z.union([
    z.enum(["event", "subject", "correlation"]),
    z.object({ function: z.object({ code: z.string().min(1) }) }),
  ]),
  onConflict: z.enum(["skip", "queue", "cancel-older", "message-existing", "coalesce"]),
});

export const correlationPolicySchema = z.object({
  key: z.enum(["event", "subject", "correlation", "none"]).default("correlation"),
});

export const agentSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), name: z.string().min(1) }),
  z.object({
    kind: z.literal("extend"),
    base: z.string().min(1),
    override: jsonRecordSchema.default({}),
  }),
  z.object({
    kind: z.literal("inline"),
    definition: jsonRecordSchema,
  }),
]);

export const automationPolicySchema = z.object({
  autonomy: z.enum(["read-only", "repo-edit", "branch-pr", "production"]),
  budget: z
    .object({
      maxDurationMs: z.number().int().positive().optional(),
      maxModelSteps: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
      maxChildRuns: z.number().int().positive().optional(),
    })
    .default({}),
  rateLimit: z
    .object({
      max: z.number().int().positive(),
      windowMs: z.number().int().positive(),
      key: z.string().optional(),
    })
    .optional(),
  executorTools: z.array(z.string()).default([]),
  builtInTools: z.array(automationBuiltInToolSchema).default([]),
  network: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  secrets: z.object({ allow: z.array(z.string()) }).optional(),
  memory: z.enum(["none", "read", "write-reviewed", "write"]).default("none"),
  approvals: z
    .array(
      z.object({
        when: z
          .enum(["before-run", "tool", "executor-tool", "output", "production"])
          .default("before-run"),
        reason: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        required: z.boolean().default(true),
      }),
    )
    .default([]),
});

const promptTemplateSchema = z.object({
  text: z.string().min(1),
});

const repoBindingSchema = z
  .object({
    owner: z.string().optional(),
    name: z.string().optional(),
    cloneUrl: z.string().optional(),
    branch: z.string().optional(),
  })
  .default({});

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("startSession"),
    mode: z.enum(["standalone", "thread-attached"]).default("standalone"),
    agent: agentSpecSchema.optional(),
    prompt: promptTemplateSchema,
    repo: repoBindingSchema,
    autoCommit: z.boolean().optional(),
    autoPr: z.boolean().optional(),
    outputSchema: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("messageSession"),
    correlation: z.enum(["subject", "event", "correlation"]).default("subject"),
    agent: agentSpecSchema.optional(),
    prompt: promptTemplateSchema,
    repo: repoBindingSchema,
    createIfMissing: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("runFunction"),
    function: z.object({
      code: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    }),
  }),
  z.object({
    kind: z.literal("emitEvent"),
    events: z.array(jsonRecordSchema).min(1),
  }),
  z.object({
    kind: z.literal("notify"),
    destination: z.enum(["inbox", "webhook", "slack", "github", "linear"]),
    target: z.string().optional(),
    message: z.string().min(1),
    payload: jsonRecordSchema.optional(),
  }),
  z.object({
    kind: z.literal("monitor"),
    prompt: promptTemplateSchema,
    childAction: jsonRecordSchema.optional(),
  }),
]);

export const outputSchema = z.object({
  kind: z.string().min(1),
  destination: z.string().optional(),
  name: z.string().optional(),
  events: z.array(z.string().min(1)).optional(),
});

export const automationDefinitionSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().positive().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(false),
  scope: automationScopeSchema,
  owner: automationOwnerSchema,
  identity: automationIdentitySchema,
  triggers: z.array(triggerSchema).default([]),
  conditions: z.array(conditionSchema).default([]),
  concurrency: concurrencyPolicySchema.default({
    key: "correlation",
    onConflict: "queue",
  }),
  correlation: correlationPolicySchema.default({ key: "correlation" }),
  agent: agentSpecSchema.optional(),
  tools: jsonRecordSchema.optional(),
  policy: automationPolicySchema.default({
    autonomy: "read-only",
    budget: {},
    executorTools: [],
    builtInTools: [],
    memory: "none",
    approvals: [],
  }),
  state: jsonRecordSchema.optional(),
  action: actionSchema,
  outputs: z.array(outputSchema).default([{ kind: "inbox" }]),
});

export const automationEventInputSchema = z.object({
  id: z.string().optional(),
  source: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().positive().default(1),
  scope: z.object({
    kind: eventScopeKindSchema,
    id: z.string().min(1),
  }),
  subject: z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
    url: z.string().optional(),
    repo: z
      .object({
        provider: z.literal("github"),
        owner: z.string().min(1),
        name: z.string().min(1),
      })
      .optional(),
  }),
  actor: jsonRecordSchema.optional(),
  occurredAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
  dedupeKey: z.string().min(1),
  correlationKey: z.string().optional(),
  trust: trustSchema.default("internal"),
  connectorId: z.string().optional(),
  installationId: z.string().optional(),
  payload: z.unknown().default({}),
  rawPayloadRef: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
});

export const automationApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
  decidedBy: z.string().min(1),
  comment: z.string().optional(),
});

export type AutomationDefinitionInput = z.input<typeof automationDefinitionSchema>;
export type AutomationDefinition = z.output<typeof automationDefinitionSchema>;
export type AutomationEventInput = z.input<typeof automationEventInputSchema>;
export type NormalizedAutomationEventInput = z.output<typeof automationEventInputSchema>;
export type AutomationApprovalDecision = z.output<typeof automationApprovalDecisionSchema>;
export type TriggerDefinition = z.output<typeof triggerSchema>;
export type ConditionDefinition = z.output<typeof conditionSchema>;
export type AutomationAction = z.output<typeof actionSchema>;
export type AutomationPolicy = z.output<typeof automationPolicySchema>;

export function parseAutomationDefinition(input: unknown): AutomationDefinition {
  return automationDefinitionSchema.parse(input);
}

export function parseAutomationEventInput(input: unknown): NormalizedAutomationEventInput {
  return automationEventInputSchema.parse(input);
}

export function hashAutomationDefinition(definition: AutomationDefinition): string {
  return hashStableString(stableStringify(definition));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableStringify(entryValue)]),
  );
}

function hashStableString(value: string): string {
  let left = 5381;
  let right = 52711;
  const modulo = 4_294_967_296;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = (left * 33 + code) % modulo;
    right = (right * 65_599 + code) % modulo;
  }

  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}
