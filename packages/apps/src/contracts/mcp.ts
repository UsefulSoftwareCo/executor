import { ProviderError } from "./provider-error.ts";
import type { NetworkRefused } from "./network.ts";
/** MCP protocol data uses Effect Schema; executable tool methods use Effect. */
import { type Effect, type Redacted, Schema } from "effect";
import type { Elicit, ElicitationFailed } from "./elicitation.ts";
import { UpstreamError } from "./failure.ts";
import type { AccountCheckContext, AuthMethods } from "./provider.ts";
import { AccountId, HttpUrl } from "./schema.ts";
import { JsonObject, type JsonValue } from "./schema.ts";
import { RouterIcon } from "./router.ts";

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

/**
 * What `mcpHealth` checks, as decoded: its options, with the account's ID, signal and deadline
 * taken from the check context.
 */
export const McpHealthInput = Schema.Struct({
  ...McpToolsOptions.fields,
  headers: Schema.Record(Schema.String, Schema.String),
  deadline: Schema.optional(Schema.Finite),
});

/**
 * The server a provider check verifies, and the headers that send the checked account's
 * credentials. The account, signal and deadline come from the check context instead. Both attempts
 * share one budget that ends `mcpHealthReserveMs` before the deadline. `timeoutMs` bounds the whole
 * check too; it can shorten the budget, never extend it.
 */
export type McpHealthOptions = Pick<typeof McpHealthInput.Type, "url" | "headers" | "timeoutMs">;

/** What `mcpHealth` reads from the check context the host passes to a provider's `health`. */
export type McpHealthCheck = Pick<AccountCheckContext<AuthMethods>, "signal" | "deadline"> & {
  readonly account: { readonly id: string };
};

/**
 * How long before an account check's deadline `mcpHealth` stops waiting for the server, so it can
 * still close its session, ending it and then its transport, each within `cleanupTimeoutMs`, and
 * report why before the host stops waiting.
 */
export const mcpHealthReserveMs = 2 * defaultMcpClientLimits.cleanupTimeoutMs + 250;

/** One parsed server and credential snapshot; never shared across account evaluations. */
export interface McpConnection {
  readonly url: URL;
  readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
  readonly timeoutMs: number;
}

export { ToolAnnotations as McpToolAnnotations } from "./tools.ts";
import { ToolAnnotations as McpToolAnnotations } from "./tools.ts";

/**
 * Native MCP result semantics, and the value every MCP tool call returns. A tool's output
 * schema is built from this declaration. Protocol/transport failures use the Effect error channel.
 */
export const McpToolResult = Schema.Struct({
  content: Schema.Array(JsonObject),
  structuredContent: Schema.optionalKey(JsonObject),
  isError: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(JsonObject),
});
export type McpToolResult = typeof McpToolResult.Type;

/**
 * Remote metadata. Input/output schemas remain upstream JSON Schema documents; the upstream
 * output schema describes only a result's `structuredContent`.
 */
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

/** What a server reports about itself when a session initializes. Icons are for display only. */
export const McpServerHeader = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  websiteUrl: Schema.optionalKey(Schema.String),
  icons: Schema.optionalKey(Schema.Array(RouterIcon)),
  instructions: Schema.optionalKey(Schema.String),
});
export type McpServerHeader = typeof McpServerHeader.Type;

/** Direct callers can omit interaction capabilities. A server that asks for input then fails explicitly. */
export interface McpToolContext {
  readonly elicit?: Elicit;
}

/**
 * A tool bound to one evaluation's account; do not reuse it with another account. `output`
 * decodes and describes the `McpToolResult` that `run` returns, with the upstream output schema
 * under `structuredContent`.
 */
export interface McpTool extends Omit<McpToolMetadata, "outputSchema"> {
  readonly description: string;
  readonly input: Schema.Decoder<JsonValue>;
  readonly output: Schema.Decoder<JsonValue>;
  readonly readOnly?: boolean;
  readonly run: (
    context: McpToolContext,
    input: JsonValue,
  ) => Effect.Effect<McpToolResult, McpError | ProviderError | NetworkRefused | ElicitationFailed>;
}
/** The discovered catalog keyed by remote tool name. */
export type McpTools = Readonly<Record<string, McpTool>>;

/**
 * Safe protocol/transport failure; no raw upstream payloads or credentials. `status` is the HTTP
 * status a `request` failure was redirected or refused with. Without one, a `request` failure in
 * the `transport` phase never reached the server; in another phase it may be a JSON-RPC error the
 * server answered with. `upstream` is that JSON-RPC error, bounded and with account secrets
 * replaced. A response that is not MCP is `invalid_response`. `session` is set when the refused
 * request carried the session ID the server issued at initialization.
 *
 * These fields describe the failure for whoever reads it. App code can set any of them, so they
 * never show that the failure lies outside Executor.
 */
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
  upstream: Schema.optional(UpstreamError),
  session: Schema.optional(Schema.Literal(true)),
  initialized: Schema.optional(Schema.Boolean),
  fallback: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["connect", "discover", "call", "schema", "transport"]),
      reason: Schema.Literals([
        "request",
        "unauthorized",
        "invalid_response",
        "timeout",
        "invalid_input",
      ]),
      status: Schema.optional(Schema.Number),
    }),
  ),
}) {}

/**
 * `mcpHealth` could not show that the server needs the account's credentials, although it accepted
 * them. `anonymous` is what the same check without credentials met: `answered` when it succeeded,
 * so a refused key would pass too, or the failure, other than a refusal, that left it undecided.
 * Only app code raises it; the host reports its fixed message, so no host protocol carries it.
 */
export class McpCredentialsUnverified extends Schema.TaggedError<McpCredentialsUnverified>()(
  "McpCredentialsUnverified",
  { anonymous: Schema.Union([Schema.Literal("answered"), McpError, ProviderError]) },
) {}

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
