import { Data, Schema } from "effect";
import type { Option } from "effect";
import type { AuthToolFailureCode } from "@executor-js/sdk";

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

/** Raised inside `invokeTool` when the connection's credential value could not
 *  be resolved (provider returned nothing / OAuth re-auth needed). v2 keys this
 *  by the connection (owner + integration + name) rather than v1's source/scope
 *  + credential-binding slot. */
export class GraphqlAuthRequiredError extends Data.TaggedError("GraphqlAuthRequiredError")<{
  readonly code: AuthToolFailureCode;
  readonly message: string;
  readonly owner: "org" | "user";
  readonly integration: string;
  readonly connection: string;
  readonly credentialKind: "secret" | "oauth" | "upstream";
  readonly credentialLabel?: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
}> {}
