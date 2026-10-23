import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/client";
import { Option, Schema } from "effect";
import {
  classifyHttpStatus,
  extractIdentity,
  extractResponseFields,
  pathNamesASecret,
  REDACTED_SAMPLE_VALUE,
  type HealthCheckReason,
  type HealthCheckResult,
  type HealthStatus,
} from "@executor-js/sdk/core";

// The SDK client validates every `tools/call` result (each connector, the
// app-server bridge included, is a transport under it) except
// `structuredContent`, which it types as unknown. The protocol requires a JSON
// object there, and identity is read from it.
const decodeStructuredContent = Schema.decodeUnknownOption(
  Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeJsonText = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

export interface McpHealthProbeOptions {
  /** Dot-path into the response body whose value names the account. */
  readonly identityField?: string;
  /** Credential values that must not appear in anything persisted. */
  readonly secrets?: readonly string[];
}

/** Structured output wins; otherwise the first text block that parses as JSON.
 *  A valid result with neither (prose, an image) is still a success, just one
 *  without a body to sample. */
const responseBody = (structuredContent: unknown, content: readonly ContentBlock[]): unknown =>
  structuredContent ??
  content
    .flatMap((block) => (block.type === "text" ? [decodeJsonText(block.text)] : []))
    .find(Option.isSome)?.value;

/** Replace every occurrence of every secret. Matches are located on the
 *  original text and merged before replacing, so a secret that contains or
 *  overlaps another is removed whole rather than leaving a suffix behind. */
export const redactSecrets = (text: string, secrets: readonly string[]): string => {
  const spans: [number, number][] = [];
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      spans.push([at, at + secret.length]);
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  let end = -1;
  for (const [start, stop] of spans) {
    if (start > end) {
      out += text.slice(cursor, start) + REDACTED_SAMPLE_VALUE;
    }
    end = Math.max(end, stop);
    cursor = end;
  }
  return out + text.slice(cursor);
};

const failed = (detail: string): HealthCheckResult => ({
  status: "degraded",
  checkedAt: Date.now(),
  reason: "probe_failed",
  detail,
});

/**
 * Classify a `tools/call` result from a configured health probe. A result that
 * reports `isError` failed even though its HTTP exchange succeeded, and its
 * content is never kept: tool error text is free-form upstream prose. Only a
 * successful result is sampled. Sample values and the identity are redacted,
 * and a sample whose path contains a credential is dropped, since a redacted
 * path would no longer select the field it names.
 */
export const classifyMcpHealthProbe = (
  result: CallToolResult,
  options: McpHealthProbeOptions = {},
): HealthCheckResult => {
  if (result.isError === true) return failed("MCP health probe returned an error.");
  const structuredContent = decodeStructuredContent(result.structuredContent);
  if (Option.isNone(structuredContent)) return failed("Malformed MCP probe response.");

  const secrets = options.secrets ?? [];
  const scrub = (value: string): string => redactSecrets(value, secrets);
  const body = responseBody(structuredContent.value, result.content);
  const identityField = options.identityField ?? "";
  const identity = extractIdentity(body, identityField);
  return {
    status: "healthy",
    checkedAt: Date.now(),
    detail: "Configured MCP probe succeeded (point-in-time check).",
    ...(identity === undefined
      ? {}
      : { identity: pathNamesASecret(identityField) ? REDACTED_SAMPLE_VALUE : scrub(identity) }),
    responseSample: extractResponseFields(body, { scrub }).filter(
      (sample) => scrub(sample.path) === sample.path,
    ),
  };
};

/** The structural signals an MCP connect, `tools/list`, or `tools/call`
 *  failure carries. Messages are deliberately absent: they can embed upstream
 *  response text, and health detail is persisted. */
export interface McpHealthFailure {
  readonly stage: "connect" | "list_tools" | "call_tool";
  readonly httpStatus?: number;
  readonly timedOut?: boolean;
  readonly reauthorizationRequired?: boolean;
  readonly insufficientScope?: boolean;
  /** Fallback only: a status-less failure whose own text says the server
   *  refused authorization. Read here, never persisted. */
  readonly authRefusedWithoutStatus?: boolean;
}

const STAGE_FAILURE_DETAIL: Record<McpHealthFailure["stage"], string> = {
  connect: "Failed connecting to MCP server",
  list_tools: "Failed listing MCP tools",
  call_tool: "MCP health probe call failed",
};

/**
 * Classify a failed health check from structural fields alone. A scope
 * shortfall is `misconfigured`: re-authenticating the same grant cannot fix
 * it. A rejected credential (401/403, reauthorization) is `expired`. Anything
 * else means the server or probe is unavailable, which is `degraded`.
 */
export const classifyMcpHealthFailure = (failure: McpHealthFailure): HealthCheckResult => {
  const { httpStatus } = failure;
  const result = (
    status: HealthStatus,
    reason: HealthCheckReason,
    detail: string,
  ): HealthCheckResult => ({
    status,
    checkedAt: Date.now(),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    reason,
    detail,
  });
  const statusReason = httpStatus === undefined ? "probe_failed" : "upstream_status";
  if (failure.insufficientScope === true) {
    return result(
      "misconfigured",
      statusReason,
      "MCP server requires additional scope. Update the credential grants.",
    );
  }
  if (failure.reauthorizationRequired === true) {
    return result("expired", statusReason, "MCP OAuth reauthorization required.");
  }
  if (failure.timedOut === true) {
    return result("degraded", "probe_timeout", "MCP server did not respond in time.");
  }
  const stage = STAGE_FAILURE_DETAIL[failure.stage];
  if (httpStatus === undefined) {
    return result(
      failure.authRefusedWithoutStatus === true ? "expired" : "degraded",
      "probe_failed",
      `${stage}.`,
    );
  }
  return classifyHttpStatus(httpStatus) === "expired"
    ? result(
        "expired",
        "upstream_status",
        `MCP server rejected the credential (HTTP ${httpStatus}).`,
      )
    : result("degraded", "upstream_status", `${stage} (HTTP ${httpStatus}).`);
};
