import type { ProviderError } from "./provider-error.ts";
/** MCP protocol data uses Effect Schema; executable tool methods use Effect. */
import { type Effect, type Redacted, Schema } from "effect";
import type { Elicit, ElicitationFailed } from "./elicitation.ts";
import { AccountId, HttpUrl } from "./schema.ts";
import { JsonObject, type JsonValue } from "./schema.ts";

/** Upstream MCP resource bounds, independent of the outer codemode execution budget. */
export const McpClientLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxTools: Schema.Int.check(Schema.isGreaterThan(0)),
  maxPaginationCursors: Schema.Int.check(Schema.isGreaterThan(0)),
  cleanupTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpClientLimits = typeof McpClientLimits.Type;
/** HTTP and stdio share discovery ceilings and the default provider timeout. */
export const defaultMcpClientLimits = McpClientLimits.make({
  timeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  maxTools: 50_000,
  maxPaginationCursors: 1_000,
  cleanupTimeoutMs: 1_000,
});
/** Platform timer ceiling, not an execution allowance; our active-time clock owns the call deadline. */
export const mcpSdkTimerCeilingMs = 2_147_483_647;

/** Server and headers for this selected account. Headers are a credential snapshot. */
export const McpToolsOptions = Schema.Struct({
  url: HttpUrl,
  accountId: Schema.optional(AccountId),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  signal: Schema.optional(Schema.instanceOf(AbortSignal)),
  timeoutMs: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: defaultMcpClientLimits.maxTimeoutMs }),
    ),
  ),
});
export type McpToolsOptions = typeof McpToolsOptions.Type;

/** One parsed server and credential snapshot; never shared across account evaluations. */
export interface McpConnection {
  readonly url: URL;
  readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
  readonly timeoutMs: number;
}

export { ToolAnnotations as McpToolAnnotations } from "./tools.ts";
import { ToolAnnotations as McpToolAnnotations } from "./tools.ts";

/** Native MCP result semantics. Protocol/transport failures use the Effect error channel. */
export const McpToolResult = Schema.Struct({
  content: Schema.Array(JsonObject),
  structuredContent: Schema.optional(JsonObject),
  isError: Schema.optional(Schema.Boolean),
  _meta: Schema.optional(JsonObject),
});
export type McpToolResult = typeof McpToolResult.Type;

/** Remote metadata. Input/output schemas remain upstream JSON Schema documents. */
export const McpToolMetadata = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: JsonObject,
  outputSchema: Schema.optional(JsonObject),
  annotations: Schema.optional(McpToolAnnotations),
  _meta: Schema.optional(JsonObject),
});
export type McpToolMetadata = typeof McpToolMetadata.Type;

/** Direct callers can omit interaction capabilities. A server that asks for input then fails explicitly. */
export interface McpToolContext {
  readonly elicit?: Elicit;
}

/** A tool bound to one evaluation's account; do not reuse it with another account. */
export interface McpTool extends McpToolMetadata {
  readonly description: string;
  readonly input: Schema.Decoder<JsonValue>;
  readonly readOnly?: boolean;
  readonly run: (
    context: McpToolContext,
    input: JsonValue,
  ) => Effect.Effect<McpToolResult, McpError | ProviderError | ElicitationFailed>;
}
/** The discovered catalog keyed by remote tool name. */
export type McpTools = Readonly<Record<string, McpTool>>;

/** Safe protocol/transport failure; no raw upstream payloads or credentials. */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  phase: Schema.Literals(["connect", "discover", "call", "schema", "transport"]),
  reason: Schema.Literals([
    "request",
    "unauthorized",
    "invalid_response",
    "timeout",
    "invalid_input",
  ]),
  status: Schema.optional(Schema.Number),
}) {}

/** Public process configuration. Credentials arrive through the selected account. */
export const ProcessConfig = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: defaultMcpClientLimits.maxTimeoutMs }),
  ),
});
export type ProcessConfig = typeof ProcessConfig.Type;
