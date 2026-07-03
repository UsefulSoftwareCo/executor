import type { AutomationDefinitionInput } from "./types";

export type AutomationTemplateId =
  | "pr-babysitter"
  | "ci-failure-fixer"
  | "linear-triage"
  | "slack-bug-triage"
  | "daily-brief"
  | "custom-webhook-triage";

export type AutomationTemplate = {
  id: AutomationTemplateId;
  name: string;
  description: string;
  definition: AutomationDefinitionInput;
};

type TemplateParams = {
  userId: string;
  scope?: {
    kind: "user" | "group" | "org";
    id: string;
  };
};

function defaultScope(params: TemplateParams) {
  return params.scope ?? { kind: "user" as const, id: params.userId };
}

export function buildAutomationTemplate(
  id: AutomationTemplateId,
  params: TemplateParams,
): AutomationDefinitionInput {
  const scope = defaultScope(params);
  const owner = { kind: "user" as const, id: params.userId };
  const identity = { kind: "user" as const, userId: params.userId };

  if (id === "pr-babysitter") {
    return {
      name: "PR babysitter",
      description:
        "Keeps a pull request moving by watching PR and check events, summarizing blockers, and continuing the same automation thread.",
      enabled: false,
      scope,
      owner,
      identity,
      triggers: [
        { kind: "event", source: "github", type: "pull_request.*" },
        { kind: "event", source: "github", type: "check_run.*" },
        { kind: "event", source: "github", type: "check_suite.*" },
      ],
      conditions: [
        {
          kind: "rate-limit",
          key: "pr-babysitter:{{event.subject.id}}",
          max: 10,
          windowMs: 15 * 60 * 1000,
        },
      ],
      concurrency: { key: "subject", onConflict: "message-existing" },
      correlation: { key: "subject" },
      policy: {
        autonomy: "branch-pr",
        budget: { maxModelSteps: 80, maxDurationMs: 45 * 60 * 1000 },
        executorTools: ["github.*", "vercel.*", "linear.*"],
        builtInTools: ["todo", "read_file", "grep", "glob"],
        memory: "read",
        approvals: [],
      },
      action: {
        kind: "messageSession",
        correlation: "subject",
        createIfMissing: true,
        prompt: {
          text: [
            "You are babysitting this pull request.",
            "Event: {{event.type}} from {{event.source}}",
            "Subject: {{event.subject.id}}",
            "Repository: {{event.subject.repo.owner}}/{{event.subject.repo.name}}",
            "Payload:",
            "{{event.payload}}",
            "Update the thread with current status, identify blockers, and propose the smallest next action. If checks failed, inspect likely causes before asking for help.",
          ].join("\n"),
        },
        repo: {},
      },
      outputs: [{ kind: "inbox" }],
    };
  }

  if (id === "ci-failure-fixer") {
    return {
      name: "CI failure fixer",
      description:
        "Starts a focused repair session when GitHub reports a failed check run or suite.",
      enabled: false,
      scope,
      owner,
      identity,
      triggers: [
        { kind: "event", source: "github", type: "check_run.completed" },
        { kind: "event", source: "github", type: "check_suite.completed" },
      ],
      conditions: [
        { kind: "field", path: "payload.conclusion", op: "in", value: ["failure", "timed_out"] },
      ],
      concurrency: { key: "subject", onConflict: "queue" },
      correlation: { key: "subject" },
      policy: {
        autonomy: "branch-pr",
        budget: { maxModelSteps: 120, maxDurationMs: 90 * 60 * 1000 },
        executorTools: ["github.*", "vercel.*"],
        builtInTools: [
          "todo",
          "read_file",
          "write_file",
          "grep",
          "glob",
          "bash",
        ],
        memory: "read",
        approvals: [
          {
            when: "production",
            reason: "Production changes still require explicit review.",
            required: true,
          },
        ],
      },
      action: {
        kind: "startSession",
        mode: "thread-attached",
        autoCommit: true,
        autoPr: true,
        prompt: {
          text: [
            "Fix this failing CI signal with the smallest coherent patch.",
            "Repository: {{event.subject.repo.owner}}/{{event.subject.repo.name}}",
            "Check subject: {{event.subject.id}}",
            "Payload:",
            "{{event.payload}}",
            "Inspect logs and recent changes, reproduce when possible, update tests if needed, and open or update a pull request with the fix.",
          ].join("\n"),
        },
        repo: {},
      },
      outputs: [{ kind: "inbox" }],
    };
  }

  if (id === "linear-triage") {
    return {
      name: "Linear triage",
      description:
        "Turns matching Linear issue activity into durable automation events and a continuing investigation thread.",
      enabled: false,
      scope,
      owner,
      identity,
      triggers: [{ kind: "event", source: "linear", type: "issue.*" }],
      conditions: [],
      concurrency: { key: "subject", onConflict: "message-existing" },
      correlation: { key: "subject" },
      policy: {
        autonomy: "repo-edit",
        budget: { maxModelSteps: 100, maxDurationMs: 60 * 60 * 1000 },
        executorTools: ["linear.*", "github.*"],
        builtInTools: ["todo", "read_file", "grep", "glob"],
        memory: "read",
        approvals: [],
      },
      action: {
        kind: "messageSession",
        correlation: "subject",
        createIfMissing: true,
        prompt: {
          text: [
            "Triage this Linear issue event.",
            "Issue: {{event.subject.id}}",
            "Payload:",
            "{{event.payload}}",
            "Summarize the user-visible request, map it to a repo if possible, and propose a concrete execution plan.",
          ].join("\n"),
        },
        repo: {},
      },
      outputs: [{ kind: "inbox" }],
    };
  }

  if (id === "slack-bug-triage") {
    return {
      name: "Slack bug triage",
      description:
        "Watches Slack messages, then keeps one triage thread per Slack conversation.",
      enabled: false,
      scope,
      owner,
      identity,
      triggers: [{ kind: "event", source: "slack", type: "message.received" }],
      conditions: [
        {
          kind: "rate-limit",
          key: "slack-triage:{{event.subject.id}}",
          max: 12,
          windowMs: 30 * 60 * 1000,
        },
      ],
      concurrency: { key: "subject", onConflict: "message-existing" },
      correlation: { key: "subject" },
      policy: {
        autonomy: "read-only",
        budget: { maxModelSteps: 60, maxDurationMs: 30 * 60 * 1000 },
        executorTools: ["github.*", "linear.*"],
        builtInTools: ["todo", "read_file", "grep", "glob"],
        memory: "read",
        approvals: [],
      },
      action: {
        kind: "messageSession",
        correlation: "subject",
        createIfMissing: true,
        prompt: {
          text: [
            "Triage this Slack signal for bug reports or support escalations.",
            "Slack thread: {{event.subject.id}}",
            "Event: {{event.type}}",
            "Payload:",
            "{{event.payload}}",
            "If this is actionable, summarize impact, identify likely owner or repo, and propose the next concrete step. If it is not actionable, record why.",
          ].join("\n"),
        },
        repo: {},
      },
      outputs: [{ kind: "inbox" }],
    };
  }

  if (id === "daily-brief") {
    return {
      name: "Daily brief",
      description:
        "Runs on a schedule and writes a concise automation inbox brief without starting a coding session.",
      enabled: false,
      scope,
      owner,
      identity,
      triggers: [
        {
          kind: "schedule",
          schedule: {
            kind: "cron",
            expression: "0 9 * * 1-5",
            timezone: "America/Chicago",
          },
        },
      ],
      conditions: [],
      concurrency: { key: "correlation", onConflict: "skip" },
      correlation: { key: "none" },
      policy: {
        autonomy: "read-only",
        budget: { maxModelSteps: 20, maxDurationMs: 10 * 60 * 1000 },
        executorTools: [],
        builtInTools: [],
        memory: "read",
        approvals: [],
      },
      action: {
        kind: "notify",
        destination: "inbox",
        message:
          "Daily automation brief is due. Review recent automation runs, blockers, and scheduled follow-ups.",
        payload: {
          source: "daily-brief",
          schedule: "weekday-0900",
        },
      },
      outputs: [{ kind: "inbox", name: "daily-brief" }],
    };
  }

  return {
    name: "Custom webhook triage",
    description:
      "Accepts custom webhook events and records a monitor artifact before escalating to a thread.",
    enabled: false,
    scope,
    owner,
    identity,
    triggers: [{ kind: "event", source: "webhook", type: "webhook.received" }],
    conditions: [
      {
        kind: "rate-limit",
        key: "custom-webhook:{{event.subject.id}}",
        max: 30,
        windowMs: 15 * 60 * 1000,
      },
    ],
    concurrency: { key: "correlation", onConflict: "queue" },
    correlation: { key: "correlation" },
    policy: {
      autonomy: "read-only",
      budget: { maxModelSteps: 50, maxDurationMs: 20 * 60 * 1000 },
      executorTools: [],
      builtInTools: ["todo", "read_file", "grep", "glob"],
      memory: "none",
      approvals: [],
    },
    action: {
      kind: "monitor",
      prompt: {
        text: [
          "Inspect this custom webhook payload.",
          "Subject: {{event.subject.id}}",
          "Payload:",
          "{{event.payload}}",
          "Return a concise classification, severity, and whether this should be escalated into a session.",
        ].join("\n"),
      },
    },
    outputs: [{ kind: "inbox" }],
  };
}

export function getAutomationTemplates(params: TemplateParams): AutomationTemplate[] {
  return (
    [
      "pr-babysitter",
      "ci-failure-fixer",
      "linear-triage",
      "slack-bug-triage",
      "daily-brief",
      "custom-webhook-triage",
    ] as const
  ).map((id) => {
    const definition = buildAutomationTemplate(id, params);
    return {
      id,
      name: definition.name,
      description: definition.description ?? "",
      definition,
    };
  });
}
