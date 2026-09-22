/** Managed reports use successful product actions, not pageviews, for adoption. */
import type {
  EventsNode,
  InsightQuerySchema,
  EventPropertyFilter,
} from "@distilled.cloud/posthog/insights";

const property = (key: string, value: string | boolean): EventPropertyFilter => ({
  key,
  value: [value],
  operator: "exact",
  type: "event",
});
const success = [property("ok", true)];
const event = (
  name: string,
  properties: EventPropertyFilter[] = [],
  math = "total",
): EventsNode => ({ kind: "EventsNode", event: name, name, properties, math });
// A HogQL predicate selects multiple event names within one series so a user is counted once.
const meaningful: EventsNode = {
  kind: "EventsNode",
  math: "dau",
  properties: [
    {
      type: "hogql",
      key: "event IN ('tool_execution_completed', 'app_mutation_completed') AND properties.ok = true",
    },
  ],
};
const human: EventPropertyFilter[] = [
  { key: "source", value: ["schedule", "workflow"], operator: "is_not", type: "event" },
];
const trend = (series: EventsNode[], breakdown?: string): InsightQuerySchema => ({
  kind: "InsightVizNode",
  source: {
    kind: "TrendsQuery",
    version: 4,
    dateRange: { date_from: "-30d" },
    interval: "day",
    filterTestAccounts: true,
    properties: human,
    series,
    ...(breakdown === undefined ? {} : { breakdownFilter: { breakdown, breakdown_type: "event" } }),
  },
});
interface UsageReport {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly query: InsightQuerySchema;
}
/** Resource IDs preserve existing saved reports while adding explicit adoption and quality views. */
export const usageReports: readonly UsageReport[] = [
  {
    id: "Visitors",
    name: "Daily visitors",
    description:
      "Visitors across marketing, docs and dashboard. Visits are not product activation.",
    query: trend([event("$pageview", [], "dau")], "surface"),
  },
  {
    id: "Executions",
    name: "Successful tool executions",
    description: "Successful completions only; approval pauses and failures are excluded.",
    query: trend([event("tool_execution_completed", success)]),
  },
  {
    id: "Connections",
    name: "Accounts connected",
    description: "Successful connections by provider.",
    query: trend([event("account_connected")], "provider_id"),
  },
  {
    id: "ActiveUsers",
    name: "Daily productive users",
    description:
      "Distinct people who successfully call a tool or mutate app data. Each person is counted once; background work is excluded.",
    query: trend([meaningful]),
  },
  {
    id: "AppUsage",
    name: "App page and data usage",
    description: "App loads, queries, subscriptions and mutations are measured separately.",
    query: trend([
      event("app_viewed"),
      event("app_query_completed", success),
      event("app_subscription_started", success),
      event("app_mutation_completed", success),
    ]),
  },
  {
    id: "FeatureUsage",
    name: "Operations by product area",
    description:
      "Authenticated API and MCP operations, including reads. This measures feature use rather than productive users.",
    query: trend([event("product_operation_completed", success)], "area"),
  },
  {
    id: "Clients",
    name: "MCP use by client",
    description:
      "Client-reported name is metadata, not trusted identity. OAuth client_id is also available for analysis.",
    query: trend([event("tool_execution_completed", success)], "client_name"),
  },
  {
    id: "Sources",
    name: "Tool use by entry point",
    description: "Dashboard, API and MCP execution paths.",
    query: trend([event("tool_execution_completed", success)], "source"),
  },
  {
    id: "Actions",
    name: "Dashboard action attempts",
    description:
      "Explicit choices and browser-native operations. No click text or field values are collected.",
    query: trend([event("product_action", [property("outcome", "started")])], "area"),
  },
  {
    id: "Errors",
    name: "Failed product operations",
    description: "Operation failures by product area; error_type is a safe discriminator.",
    query: trend([event("product_operation_completed", [property("ok", false)])], "area"),
  },
  {
    id: "Latency",
    name: "Tool duration p95",
    description:
      "Execution duration in milliseconds, including failures; approval pauses are separate events.",
    query: trend([
      { ...event("tool_execution_completed"), math: "p95", math_property: "duration_ms" },
    ]),
  },
  {
    id: "Activation",
    name: "Signup to first tool success",
    description:
      "Seven-day ordered funnel. Users who only use app pages have a separate activation funnel.",
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-30d" },
        funnelsFilter: { funnelWindowInterval: 7, funnelWindowIntervalUnit: "day" },
        series: [event("cloud_signup_completed"), event("tool_execution_completed", success)],
      },
    },
  },
  {
    id: "AppActivation",
    name: "Signup to app action",
    description: "Seven-day activation through successful app mutations.",
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-30d" },
        funnelsFilter: { funnelWindowInterval: 7, funnelWindowIntervalUnit: "day" },
        series: [event("cloud_signup_completed"), event("app_mutation_completed", success)],
      },
    },
  },
  {
    id: "ToolRetention",
    name: "Weekly tool return use",
    description:
      "People returning to successful tool use after their first observed success. Not pageview retention.",
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "RetentionQuery",
        filterTestAccounts: true,
        dateRange: { date_from: "-8w" },
        properties: human,
        retentionFilter: {
          period: "Week",
          totalIntervals: 8,
          retentionType: "retention_first_time",
          targetEntity: { id: "tool_execution_completed", type: "events", properties: success },
          returningEntity: { id: "tool_execution_completed", type: "events", properties: success },
        },
      },
    },
  },
  {
    id: "Automation",
    name: "Background schedule and workflow outcomes",
    description:
      "Schedule terminal transitions and workflow engine attempts. Workflow retries can produce multiple attempts per run; these identities are not people.",
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "TrendsQuery",
        dateRange: { date_from: "-30d" },
        interval: "day",
        filterTestAccounts: true,
        series: [event("schedule_run_completed"), event("workflow_attempt_completed")],
        breakdownFilter: { breakdown: "outcome", breakdown_type: "event" },
      },
    },
  },
];
