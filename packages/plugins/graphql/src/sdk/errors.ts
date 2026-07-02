import { Data, Schema } from "effect";
import type { Option } from "effect";
import type { AuthToolFailureCode } from "@executor-js/sdk/core";

export class GraphqlIntrospectionError extends Schema.TaggedErrorClass<GraphqlIntrospectionError>()(
  "GraphqlIntrospectionError",
  {
    message: Schema.String,
  },
) {}

export class GraphqlExtractionError extends Schema.TaggedErrorClass<GraphqlExtractionError>()(
  "GraphqlExtractionError",
  {
    message: Schema.String,
  },
) {}

export class GraphqlInvocationError extends Data.TaggedError("GraphqlInvocationError")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}

/** A tool invocation could not produce a usable credential. Re-keyed for v2:
 *  references the connection by (owner, integration, name) instead of a v1
 *  source id + scope. */
export class GraphqlAuthRequiredError extends Data.TaggedError("GraphqlAuthRequiredError")<{
  readonly code: AuthToolFailureCode;
  readonly message: string;
  readonly owner: string;
  readonly integration: string;
  readonly connection: string;
  readonly credentialKind: "secret" | "oauth" | "upstream";
  readonly credentialLabel?: string;
  readonly template?: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
}> {}
