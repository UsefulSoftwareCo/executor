/**
 * Dashboard reads the browser starts together travel as one request, addressed by the API's own
 * group and endpoint names. The host answers each one with that endpoint's registered handler and
 * middleware, under the batch request's identity, and streams the answers back as JSON lines in
 * the order they finish. One request serves a page's reads in one isolate.
 */
import { Predicate, Schema } from "effect";
import type { HttpApiEndpoint } from "effect/http-api";
import { HttpApiSchema } from "effect/http-api";

/** Every host that batches serves its batches here, beside its API. */
export const dashboardBatchPath = "/api/dashboard/batch";

/** A batch is a page's worth of reads. More are sent as further batches. */
export const maxBatchReads = 32;

/**
 * The single rule for which endpoints a batch may read: a `GET` whose success is one buffered body
 * and whose request declares no headers. A stream would hold the batch open, and declared headers
 * would have to travel per read, where they could name another identity. Endpoints that set
 * cookies must not be in an API given to a batch: a batch's headers leave before its reads finish.
 * The hosted APIs' authentication lives outside them, under `/api/auth`.
 */
export const batchable = (endpoint: HttpApiEndpoint.Top): boolean =>
  endpoint.method === "GET" &&
  endpoint.headers === undefined &&
  [...endpoint.success].every(
    (schema) => !streams(HttpApiSchema.isWithHeaders(schema) ? schema.schema : schema),
  );

/** `HttpApiSchema.StreamSse` and `StreamUint8Array` schemas carry these public tags. */
const streams = (schema: unknown) =>
  Predicate.hasProperty(schema, "_tag") &&
  (schema._tag === "StreamSse" || schema._tag === "StreamUint8Array");

/**
 * One read: an endpoint of the host's API, with its path parameters and query as sent, and the
 * W3C trace context of the browser span that made it, so its server span joins that trace.
 */
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

/**
 * One read's answer, exactly as its endpoint encoded it: the status and the body its success or
 * error schema produced. A textual body travels as text and any other as base64. A read the
 * stream ends without has no answer.
 */
export const BatchAnswer = Schema.Struct({
  id: Schema.Int,
  status: Schema.Int,
  contentType: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  bytes: Schema.optional(Schema.Uint8ArrayFromBase64),
});
export type BatchAnswer = typeof BatchAnswer.Type;
