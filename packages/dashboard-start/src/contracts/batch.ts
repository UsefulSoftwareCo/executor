import { Predicate, Schema } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import { HttpApiSchema } from "effect/http-api";

export const dashboardBatchPath = "/api/dashboard/batch";

export const maxBatchReads = 32;

export const batchable = (endpoint: HttpApiEndpoint.Top): boolean =>
  endpoint.method === "GET" &&
  endpoint.headers === undefined &&
  [...endpoint.success].every(
    (schema) => !streams(HttpApiSchema.isWithHeaders(schema) ? schema.schema : schema),
  );

const streams = (schema: unknown) =>
  Predicate.hasProperty(schema, "_tag") &&
  (schema._tag === "StreamSse" || schema._tag === "StreamUint8Array");

export const BatchRead = Schema.Struct({
  id: Schema.Int,
  group: Schema.String,
  endpoint: Schema.String,
  params: Schema.Record(Schema.String, Schema.String),
  query: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  traceparent: Schema.optional(Schema.String),
});
export type BatchRead = typeof BatchRead.Type;

export const Batch = Schema.Struct({
  reads: Schema.Array(BatchRead).check(Schema.isMinLength(1), Schema.isMaxLength(maxBatchReads)),
});
export type Batch = typeof Batch.Type;

export const BatchAnswer = Schema.Struct({
  id: Schema.Int,
  status: Schema.Int,
  contentType: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  bytes: Schema.optional(Schema.Uint8ArrayFromBase64),
});
export type BatchAnswer = typeof BatchAnswer.Type;
