/** Retained Worker code and optional private browser asset metadata. */
import { UiAsset } from "./runtime.ts";
import { Schema } from "effect";

export { WorkerBundle } from "@executor-js/app-data/worker-bundle";
import { WorkerBundle } from "@executor-js/app-data/worker-bundle";
export type WorkerBundle = typeof WorkerBundle.Type;

/** Published apps carry their own executable framework. Version 1 uses the existing host protocol. */
export const PublishedAppFramework = Schema.Struct({
  protocol: Schema.Literal(1),
  version: Schema.NonEmptyString,
  server: Schema.Record(Schema.String, Schema.String),
  browser: Schema.Record(Schema.String, Schema.String),
});

/** The existing bundle key remains the publication point; builds without a UI omit its metadata. */
export const RetainedWorkerBuild = Schema.Struct({
  ...WorkerBundle.fields,
  database: Schema.Boolean,
  ui: Schema.optional(Schema.Array(UiAsset)),
});
