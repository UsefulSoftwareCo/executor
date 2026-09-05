// ---------------------------------------------------------------------------
// Browser-approval primitives shared by every host that surfaces a paused MCP
// execution to a human for approval in the browser.
//
// When a connection runs in `elicitation_mode=browser`, a gated tool call
// pauses and the host returns an `approvalUrl` pointing at the console's
// `/resume/:executionId` page. The user approves or declines there; the host
// records the decision and the model's `resume` tool call — long-polling the
// host's `BrowserApprovalStore` — consumes it.
//
// Three hosts implement that flow over two transports: the in-process handler
// (apps/local, host-selfhost) and the Durable Object (cloud, host-cloudflare).
// The wire-shape pieces are identical across all of them, so they live here
// once: how the mode is read off the request, how the approval URL is built,
// the resume-payload schema, and the acknowledgement text/structured content.
// Each caller keeps its own transport envelope (HTTP JSON vs DO RPC result) and
// wraps this neutral core — that is the only part that legitimately differs.
//
// This module stays dependency-light (effect + a type from execution + Web
// APIs) so the Cloudflare worker/DO bundles can pull it without dragging in the
// HTTP API assembly.
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";

import type { ResumeResponse } from "@executor-js/execution";

export type McpElicitationMode = "browser" | "model" | "native";

const MCP_ELICITATION_MODES = new Set<McpElicitationMode>(["browser", "model", "native"]);

const TRUE_QUERY_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Read the elicitation mode off an MCP request's `?elicitation_mode=` query.
 * Unknown or absent values fall back to `model` (the default — the agent calls
 * `resume` inline). `?allow_model_resume=true` is a legacy alias for `model`.
 */
export const readElicitationMode = (request: Request): McpElicitationMode => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("elicitation_mode");
  if (mode && MCP_ELICITATION_MODES.has(mode as McpElicitationMode)) {
    return mode as McpElicitationMode;
  }

  const legacyModelResume = url.searchParams.get("allow_model_resume");
  if (legacyModelResume !== null && TRUE_QUERY_VALUES.has(legacyModelResume.toLowerCase())) {
    return "model";
  }

  return "model";
};

/**
 * Read the artifacts opt-OUT off an MCP request's `?artifacts=` query.
 * Artifacts are ON by default: a clean endpoint URL gets the full artifact
 * surface, and only an explicit false value (`?artifacts=false`, or any
 * spelling that isn't one of the accepted truthy forms) withholds it. A
 * session that opts out gets no artifact tools, no `ui://` shell resource,
 * and no artifact skills — as if the host had never been configured for them.
 * `?artifacts=true` remains accepted and is simply the default made explicit.
 */
export const readArtifactsEnabled = (request: Request): boolean => {
  const value = new URL(request.url).searchParams.get("artifacts");
  if (value === null) return true;
  return TRUE_QUERY_VALUES.has(value.toLowerCase());
};

/**
 * Read the per-integration search tools opt-IN off an MCP request's
 * `?search_tools=` query. OFF by default: a clean endpoint URL serves only the
 * core surface, and only an accepted truthy spelling (`?search_tools=true`)
 * adds one `search_<integration>` tool per connected integration. Any other
 * explicit value reads as the default (disabled).
 */
export const readSearchToolsEnabled = (request: Request): boolean => {
  const value = new URL(request.url).searchParams.get("search_tools");
  if (value === null) return false;
  return TRUE_QUERY_VALUES.has(value.toLowerCase());
};

export type McpToolMode = "codemode" | "passthrough";

/**
 * Read the tool surface mode off an MCP request's `?mode=` query. The default,
 * `codemode`, serves `execute` (the model writes sandboxed TypeScript against
 * `tools.*`). `?mode=passthrough` instead serves every visible integration
 * tool as its own MCP tool, with no `execute`, `skills`, or `resume`: the
 * harness's native approval reads the advertised annotations. Any other value
 * reads as the default.
 */
export const readToolMode = (request: Request): McpToolMode => {
  const value = new URL(request.url).searchParams.get("mode");
  return value === "passthrough" ? "passthrough" : "codemode";
};

/**
 * Read the optional integration filter for passthrough mode off `?integrations=`,
 * a comma-separated list of integration slugs. Absent or empty means every
 * visible integration. Only meaningful with `?mode=passthrough`; codemode has
 * `tools.search` for scoping. Slugs are trimmed and de-duplicated; order is
 * not significant.
 */
export const readPassthroughIntegrations = (request: Request): readonly string[] | undefined => {
  const value = new URL(request.url).searchParams.get("integrations");
  if (value === null) return undefined;
  const slugs = Array.from(
    new Set(
      value
        .split(",")
        .map((slug) => slug.trim())
        .filter((slug) => slug.length > 0),
    ),
  );
  return slugs.length === 0 ? undefined : slugs;
};

/**
 * Build the console approval URL for a paused execution:
 * `<origin>/<organizationSlug>/resume/<executionId>?mcp_session_id=<sessionId>`
 * when the host knows the org slug, otherwise
 * `<origin>/resume/<executionId>?mcp_session_id=<sessionId>`. The
 * `mcp_session_id` query routes the console's resume page back to the host's
 * approval endpoint for that session.
 */
export const buildResumeApprovalUrl = (input: {
  readonly origin: string | URL;
  readonly executionId: string;
  readonly sessionId?: string | null;
  readonly organizationSlug?: string | null;
}): string => {
  const orgPath = input.organizationSlug ? `/${encodeURIComponent(input.organizationSlug)}` : "";
  const url = new URL(`${orgPath}/resume/${encodeURIComponent(input.executionId)}`, input.origin);
  if (input.sessionId) url.searchParams.set("mcp_session_id", input.sessionId);
  return url.toString();
};

/** `buildResumeApprovalUrl` anchored at the request's own origin (in-process hosts). */
export const approvalUrlForRequest = (
  request: Request,
  executionId: string,
  sessionId: string | null,
): string => buildResumeApprovalUrl({ origin: request.url, executionId, sessionId });

/** The resume decision a console posts back: an action plus optional form content. */
export const ResumeResponsePayload = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const decodeResumeResponsePayload = Schema.decodeUnknownOption(ResumeResponsePayload);

/** Decode an untrusted resume payload, or `null` if it doesn't match the contract. */
export const decodeResumeResponse = (raw: unknown): ResumeResponse | null =>
  Option.getOrNull(decodeResumeResponsePayload(raw));

const ACKNOWLEDGEMENT_TEXT = {
  accept: "I've approved it",
  decline: "I've denied it",
  cancel: "I've canceled it",
} satisfies Record<ResumeResponse["action"], string>;

const ACKNOWLEDGEMENT_STATUS = {
  accept: "approved",
  decline: "denied",
  cancel: "canceled",
} satisfies Record<ResumeResponse["action"], string>;

/**
 * The transport-neutral acknowledgement a host returns once a browser approval
 * decision is recorded: human-facing `text` plus `structured` content the
 * console renders. Each host wraps this in its own envelope (HTTP JSON for the
 * in-process handler, the DO RPC result for Cloudflare).
 */
export const formatResumeAcknowledgement = (
  executionId: string,
  response: ResumeResponse,
): {
  readonly text: string;
  readonly structured: { readonly status: string; readonly executionId: string };
} => ({
  text: ACKNOWLEDGEMENT_TEXT[response.action],
  structured: { status: ACKNOWLEDGEMENT_STATUS[response.action], executionId },
});
