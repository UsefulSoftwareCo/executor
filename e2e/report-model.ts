import { Schema } from "effect";
import { TestPlan } from "./test-plan.ts";

/** Each run names the product, deployment mode and exact server being tested. */
export const Target = Schema.Literals(["self-host", "local", "cloud"]);
/** Persisted run metadata contains no credentials or session state. */
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
});
/** Portable evidence links copied into the report folder. */
export const Attachment = Schema.Struct({
  name: Schema.String,
  contentType: Schema.String,
  href: Schema.String,
});
/** Test identities include the Vitest scenario, target and source file. */
export const EvidenceEntry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  file: Schema.String,
  target: Target,
  status: Schema.String,
  duration: Schema.Number,
  errors: Schema.Array(Schema.String),
  annotations: Schema.Array(Schema.Struct({ type: Schema.String, description: Schema.String })),
  attachments: Schema.Array(Attachment),
});
/** Result list retained by one or more target runs. */
export const EvidenceEntries = Schema.Array(EvidenceEntry);
/** Serialized report boundary shared by the reporter and React reader. */
export const EvidenceReport = Schema.Struct({
  runs: Schema.Array(RunMetadata),
  entries: EvidenceEntries,
  plan: Schema.Array(TestPlan),
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
