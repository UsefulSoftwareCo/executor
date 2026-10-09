/**
 * What the host keeps of the spans and logs an app isolate returns.
 *
 * Those records come from whatever framework the app's build bundles, and the app's own code runs
 * in the same isolate: it can throw any text, name its errors and codes, and rewrite every record
 * before the isolate returns it. So the host does not filter the records it receives. It builds
 * new ones from a closed vocabulary: the framework's span names, attributes whose values are
 * closed sets, counts and status codes, and each exception's kind. Ids, parents and timings are
 * kept. Everything else, including events other than exceptions, links, status and exception
 * messages, stacks and log bodies, is dropped or replaced with a fixed sentence.
 *
 * The vocabulary is the framework's (`packages/apps`, `app-cache`, `app-data`): host request
 * operations, failure sources and reasons, MCP and cache attributes. A name or value outside it is
 * recorded as `unrecognized` or not at all. `bun run check` (`scripts/check-app-telemetry.ts`)
 * fails when the framework names a span or sets an attribute key this vocabulary does not know.
 */
import type { Schema } from "effect";

type Json = Schema.Json;
type JsonObject = { readonly [key: string]: Json };
type Attribute = { readonly key: string; readonly value: JsonObject };

/** What an exception message, stack or log body from an app isolate records instead. */
export const appText = "Text from the app is not recorded";
/** Recorded for a span name, error kind or failure code outside the vocabulary. */
const unrecognized = "unrecognized";

const operations = [
  "requirements",
  "inspect",
  "skills",
  "query",
  "mutate",
  "call",
  "account-check",
  "webhooks",
  "webhook-validate",
  "webhook-complete",
  "webhook-register",
  "webhook-unregister",
  "webhook-handle",
  "workflows",
  "workflow-validate",
  "workflow-run",
  "migrate",
];
const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
];

/** The framework's span names, and the libraries' spans it runs. */
export const appSpanNames: ReadonlySet<string> = new Set([
  "app.dispatch",
  ...operations.map((operation) => `app.${operation}`),
  "app.evaluate",
  "app.accounts.bind",
  "app.account.check",
  "app.catalog.read",
  "app.skills.load",
  "app.skills.routers",
  "app.tool.resolve",
  "app.tool.approval",
  "app.tool.elicitation",
  "app.elicitation.wait",
  "app.workflow.control",
  "app.operation.execute",
  "app.sql.migrate",
  "app.code",
  "app.cache.call",
  "app.cache.get",
  "app.cache.load",
  "app.cache.command",
  "app.cache.publish",
  "app.cache.flush",
  "app.cache.lease.renew",
  "provider.http.request",
  "provider.http.response.read",
  "provider.openapi.call",
  "provider.graphql.request",
  "provider.graphql.call",
  "provider.mcp.session",
  "provider.mcp.connect",
  "provider.mcp.close",
  "provider.mcp.request",
  "provider.mcp.call",
  "provider.mcp.discover",
  "provider.mcp.check",
  "provider.mcp.health",
  "provider.mcp.anonymous",
  "provider.mcp.elicitation",
  "sql.execute",
  ...httpMethods.map((method) => `http.client ${method}`),
]);

/**
 * Error kinds: the host protocol's errors, the framework's failures and helpers' errors, the
 * runtime's and Effect's own, and the kinds of value JavaScript can throw. An app's own error
 * classes are `unrecognized`.
 */
const errorKinds: ReadonlySet<string> = new Set([
  "HostRequestInvalid",
  "HostAccountsInvalid",
  "HostDeclarationInvalid",
  "HostEvaluationFailed",
  "HostOperationNotFound",
  "HostOperationFailed",
  "HostKindMismatch",
  "HostToolNotFound",
  "HostInputInvalid",
  "HostOutputInvalid",
  "HostToolBlocked",
  "HostToolApprovalRequired",
  "HostToolPolicyFailed",
  "ElicitationFailed",
  "DatabaseLimitExceeded",
  "DatabaseFieldReserved",
  "SkillLoadFailed",
  "WorkflowFailure",
  "ProviderError",
  "OpenapiResponseError",
  "OpenapiError",
  "OpenapiCompileError",
  "GraphqlError",
  "McpError",
  "McpToolError",
  "McpCredentialsUnverified",
  "CacheError",
  "AppDatabaseError",
  "AppStorageError",
  "AppStorageUnavailable",
  "NetworkRefused",
  "FetchOptionUnsupported",
  "LogicalOperationFailed",
  "HttpClientError",
  "SchemaError",
  "TimeoutError",
  "UnknownError",
  "InterruptError",
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "string",
  "number",
  "bigint",
  "boolean",
  "symbol",
  "undefined",
  "object",
  "function",
]);

/** The reasons the framework's own failures carry as their code. An app's own codes are not. */
const failureCodes: ReadonlySet<string> = new Set([
  // CacheError
  "unavailable",
  "storage",
  "invalid",
  "capacity",
  "timeout",
  // AppDatabaseError
  "schema",
  "schema_changed",
  "table",
  "index",
  "range",
  "value",
  "readonly",
  "cursor",
  "limit",
  "closed",
  "replay",
  // OpenapiError
  "invalid_definition",
  "invalid_input",
  "request",
  // McpError, McpCredentialsUnverified and ProviderError
  "unauthorized",
  "invalid_response",
  "forbidden",
  "rate_limited",
  "rejected",
  "anonymous_access",
  // NetworkRefused and FetchOptionUnsupported
  "private_address",
  "credential_host",
  "credential_app",
  "credential_expired",
  "redirect",
  "cache",
  "integrity",
]);

const text = (value: JsonObject) =>
  typeof value["stringValue"] === "string" ? value["stringValue"] : undefined;
const integer = (value: JsonObject) => {
  const raw = value["intValue"];
  const number = typeof raw === "string" && /^-?\d{1,15}$/.test(raw) ? Number(raw) : raw;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
};

type Kept = (value: JsonObject) => JsonObject | undefined;
const oneOf =
  (...values: ReadonlyArray<string>): Kept =>
  (value) => {
    const found = text(value);
    return found !== undefined && values.includes(found) ? { stringValue: found } : undefined;
  };
/** A value from `known`, or `unrecognized` for any other text. */
const classified =
  (known: ReadonlySet<string>): Kept =>
  (value) => {
    const found = text(value);
    return found === undefined
      ? undefined
      : { stringValue: known.has(found) ? found : unrecognized };
  };
const flag: Kept = (value) =>
  typeof value["boolValue"] === "boolean" ? { boolValue: value["boolValue"] } : undefined;
const count: Kept = (value) => {
  const found = integer(value);
  return found !== undefined && found >= 0 ? { intValue: found } : undefined;
};
const status: Kept = (value) => {
  const found = integer(value);
  return found !== undefined && found >= 100 && found <= 599 ? { intValue: found } : undefined;
};
/** Milliseconds the framework measured; Effect writes whole values as integers. */
const duration: Kept = (value) => {
  const found = typeof value["doubleValue"] === "number" ? value["doubleValue"] : integer(value);
  return found !== undefined && Number.isFinite(found) && found >= 0
    ? { doubleValue: found }
    : undefined;
};

/** Every span attribute the host keeps, with the values it accepts. */
const spanAttributes: Readonly<Record<string, Kept>> = {
  "executor.operation": oneOf(...operations, "mutation", "discover"),
  "executor.outcome": oneOf("failed"),
  "executor.clock.type": oneOf("system", "cloudflare-io"),
  "executor.trace.parent_sampled": flag,
  "executor.failure.source": oneOf("app", "storage", "service"),
  "executor.failure.code": classified(failureCodes),
  "error.type": classified(errorKinds),
  "cache.operation": oneOf(
    "read",
    "acquire",
    "claim",
    "publish",
    "release",
    "renew",
    "write",
    "invalidate",
  ),
  "cache.result": oneOf("fresh", "stale", "miss", "local"),
  "cache.load.leased": flag,
  "cache.flush.index": count,
  "cache.flush.count": count,
  "cache.flush.entries": count,
  "cache.flush.bytes": count,
  "cache.leases": count,
  "mcp.transport": oneOf("http", "sse", "stdio"),
  "mcp.operation": oneOf("discover", "call", "check", "health"),
  "mcp.tool.is_error": flag,
  "rpc.system.name": oneOf("jsonrpc"),
  "rpc.method": oneOf("initialize", "tools/list", "tools/call", "ping"),
  "graphql.operation.type": oneOf("query", "mutation", "subscription"),
  "db.system.name": oneOf("sqlite"),
  "db.operation.name": oneOf("execute"),
  "http.request.method": oneOf(...httpMethods),
  "http.response.status_code": status,
  "url.scheme": oneOf("http", "https"),
  "span.label": oneOf("⚠︎ Interrupted"),
  "status.interrupted": flag,
  "executor.milestone.reached": flag,
  "executor.owner": oneOf("executor", "app", "upstream", "person"),
  "executor.app.code": oneOf(
    "factory",
    "router",
    "approval",
    "handler",
    "loader",
    "cache",
    "webhook",
    "check",
    "skills",
    "elicitation",
    "workflow",
    "step",
  ),
  "executor.workflow.operation": oneOf("start", "get", "list", "terminate"),
  "cache.method": oneOf("get", "revalidate", "read", "readMany", "write", "invalidate"),
  "executor.upstream.wait_ms": duration,
  "executor.elicitation.wait_ms": duration,
  "executor.authored_ms": duration,
  "executor.overhead_ms": duration,
};
export const appSpanAttributeKeys: ReadonlySet<string> = new Set(Object.keys(spanAttributes));
/**
 * Attributes the framework sets whose values the app chooses, such as its tool names, so the host
 * drops them. `scripts/check-app-telemetry.ts` fails on a framework attribute in neither set.
 */
export const droppedAppAttributeKeys: ReadonlySet<string> = new Set([
  "executor.tool.name",
  "mcp.tool.name",
  "server.address",
  // A request's path and route in an app's isolate are the app's.
  "url.path",
  "http.route",
]);

/** The framework's own log messages. Any other log body is the app's text. */
const logMessages: ReadonlySet<string> = new Set([
  "The app's request failed unexpectedly",
  "App cache refresh failed",
  "MCP catalog invalidation failed",
  "Telemetry export failed",
]);

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const spanId = (value: Json | undefined) =>
  typeof value === "string" && /^[a-f0-9]{16}$/.test(value) ? value : undefined;
/** OTLP nanosecond timestamps, as Effect writes them. */
const nanos = (value: Json | undefined) =>
  typeof value === "string" && /^\d{1,20}$/.test(value) ? value : undefined;
const between = (value: Json | undefined, minimum: number, maximum: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;

const attributes = (from: Json | undefined): Array<Attribute> =>
  (Array.isArray(from) ? from : []).flatMap((attribute) => {
    if (!isObject(attribute) || typeof attribute["key"] !== "string") return [];
    const key = attribute["key"];
    const keep = Object.hasOwn(spanAttributes, key) ? spanAttributes[key] : undefined;
    const value = attribute["value"];
    const kept = keep === undefined || !isObject(value) ? undefined : keep(value);
    return kept === undefined ? [] : [{ key, value: kept }];
  });

/** An exception's kind, with a fixed message and an Executor-generated stack. */
const exception = (event: JsonObject) => {
  const named = (Array.isArray(event["attributes"]) ? event["attributes"] : []).find(
    (attribute) => isObject(attribute) && attribute["key"] === "exception.type",
  );
  const type = isObject(named) && isObject(named["value"]) ? text(named["value"]) : undefined;
  const recorded = type !== undefined && errorKinds.has(type) ? type : unrecognized;
  const time = nanos(event["timeUnixNano"]);
  return {
    name: "exception",
    ...(time === undefined ? {} : { timeUnixNano: time }),
    attributes: [
      { key: "exception.type", value: { stringValue: recorded } },
      { key: "exception.message", value: { stringValue: appText } },
      { key: "exception.stacktrace", value: { stringValue: `${recorded}: ${appText}` } },
    ],
  };
};

/** The span the host records for one an app isolate returned, or nothing without its timings. */
export const appSpan = (
  span: JsonObject & { readonly traceId: string; readonly spanId: string },
): JsonObject | undefined => {
  const start = nanos(span["startTimeUnixNano"]);
  const end = nanos(span["endTimeUnixNano"]);
  if (start === undefined || end === undefined) return undefined;
  const parent = spanId(span["parentSpanId"]);
  const kind = between(span["kind"], 0, 5);
  const code = isObject(span["status"]) ? between(span["status"]["code"], 0, 2) : undefined;
  const name =
    typeof span["name"] === "string" && appSpanNames.has(span["name"])
      ? span["name"]
      : "app.unrecognized";
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parent === undefined ? {} : { parentSpanId: parent }),
    name,
    ...(kind === undefined ? {} : { kind }),
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: attributes(span["attributes"]),
    events: (Array.isArray(span["events"]) ? span["events"] : []).flatMap((event) =>
      isObject(event) && event["name"] === "exception" ? [exception(event)] : [],
    ),
    ...(code === undefined ? {} : { status: { code } }),
  };
};

/** The log record the host records for one an app isolate returned. */
export const appLog = (
  log: JsonObject & { readonly traceId?: string | undefined; readonly spanId?: string | undefined },
): JsonObject => {
  const time = nanos(log["timeUnixNano"]);
  const observed = nanos(log["observedTimeUnixNano"]);
  const severity = between(log["severityNumber"], 1, 24);
  const level = log["severityText"];
  const body = isObject(log["body"]) ? text(log["body"]) : undefined;
  return {
    ...(log.traceId === undefined ? {} : { traceId: log.traceId }),
    ...(log.spanId === undefined ? {} : { spanId: log.spanId }),
    ...(time === undefined ? {} : { timeUnixNano: time }),
    ...(observed === undefined ? {} : { observedTimeUnixNano: observed }),
    ...(severity === undefined ? {} : { severityNumber: severity }),
    ...(typeof level === "string" &&
    ["Trace", "Debug", "Info", "Warn", "Error", "Fatal"].includes(level)
      ? { severityText: level }
      : {}),
    body: { stringValue: body !== undefined && logMessages.has(body) ? body : appText },
  };
};
