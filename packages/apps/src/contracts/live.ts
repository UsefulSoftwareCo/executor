/** Browser subscription contracts contain no executable server declarations. */
import { Schema } from "effect";
import type { JsonValue } from "./schema.ts";

/** Serializable named reference; the phantom field is never populated at runtime. */
export interface OperationReference<Input, Output, Kind extends "query" | "mutation"> {
  readonly name: string;
  readonly kind: Kind;
  readonly _types?: { readonly input: Input; readonly output: Output };
}
/** Host-bound subscription request. Authentication and configured app identity belong to the host. */
export interface QueryDescriptor {
  readonly name: string;
  readonly input: JsonValue;
}
/** Host transport must close its subscription when async iteration ends. Results are parsed by the client. */
export interface QueryTransport {
  readonly subscribe: (descriptor: QueryDescriptor) => Promise<AsyncIterable<unknown>>;
}
/** Safe client failure; arbitrary transport errors and response data are never exposed. */
export class AppQueryFailed extends Schema.TaggedError<AppQueryFailed>()("AppQueryFailed", {}) {}
