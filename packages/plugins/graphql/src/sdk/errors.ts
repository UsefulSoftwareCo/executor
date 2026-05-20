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

export class GraphqlAuthRequiredError extends Data.TaggedError("GraphqlAuthRequiredError")<{
  readonly code: AuthToolFailureCode;
  readonly message: string;
  readonly sourceId: string;
  readonly sourceScope: string;
  readonly credentialKind: "secret" | "connection" | "oauth" | "upstream";
  readonly credentialLabel?: string;
  readonly slotKey?: string;
  readonly secretId?: string;
  readonly connectionId?: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
}> {}
