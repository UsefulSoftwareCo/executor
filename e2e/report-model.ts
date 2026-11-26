import { Schema } from "effect";
import { TestPlan } from "./test-plan.ts";

export const Target = Schema.Literals(["self-host", "local", "cloud"]);
export const RunMetadata = Schema.Struct({
  target: Target,
  origin: Schema.String,
  mode: Schema.Literals(["managed", "attached"]),
  runtime: Schema.String,
  commit: Schema.String,
  dirty: Schema.Boolean,
  startedAt: Schema.String,
  interactive: Schema.Boolean,
  diagnostics: Schema.String,
  browserOrigin: Schema.optional(Schema.Literal("deployment")),
  oauthProxyProduction: Schema.optional(Schema.String),
});
export const Attachment = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  href: Schema.String,
});
export const EvidenceEntry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  file: Schema.String,
  target: Target,
  origin: Schema.optional(Schema.String),
  status: Schema.String,
  startedAt: Schema.optional(Schema.Number),
  duration: Schema.Number,
  errors: Schema.Array(Schema.String),
  annotations: Schema.Array(Schema.Struct({ type: Schema.String, description: Schema.String })),
  attachments: Schema.Array(Attachment),
});
export const EvidenceEntries = Schema.Array(EvidenceEntry);
export const EvidenceReport = Schema.Struct({
  runs: Schema.Array(RunMetadata),
  entries: EvidenceEntries,
  plan: Schema.Array(TestPlan),
  outcome: Schema.optional(Schema.Literals(["passed", "failed"])),
}).check(
  Schema.makeFilter(
    (report) =>
      report.runs.length > 0 &&
      new Set(report.runs.map((run) => run.target)).size === report.runs.length &&
      report.entries.every((entry) => report.runs.some((run) => run.target === entry.target)),
    { message: "Every test must belong to one uniquely identified target run" },
  ),
);
export type EvidenceReport = typeof EvidenceReport.Type;
