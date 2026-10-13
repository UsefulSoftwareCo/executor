// ---------------------------------------------------------------------------
// Forwarding MCP requests of a moved organization to Executor v2.
//
// An organization that has moved keeps using its v1 MCP URLs. v1 still
// authenticates the caller (AuthKit token or user API key, plus membership),
// then, instead of dispatching to a session Durable Object, forwards the
// request to v2's MCP endpoint over the `V2_MCP` service binding with a signed
// credential naming the v1 account and organization:
//
//   Authorization: Bearer v1fwd.<payload>.<sig>
//
//   payload  base64url (no padding) of the UTF-8 JSON
//            {"v":1,"account","organization","exp"[,"toolkit","connection"]}
//   sig      base64url (no padding) of HMAC-SHA256 over "v1fwd." + payload,
//            keyed by the shared secret's UTF-8 bytes
//
// A fresh token is minted per forwarded request and expires after ten
// minutes. Nothing here falls back to v1 data: when the binding or secret is
// missing, or v2 cannot be reached, the caller gets a retryable 503.
// ---------------------------------------------------------------------------

import { jsonRpcErrorBody, UNAVAILABLE_RETRY_AFTER_SECONDS } from "@executor-js/host-mcp";
import { readElicitationMode, readToolMode } from "@executor-js/cloudflare/mcp/do-headers";
import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { MovedToV2 } from "./moved-to-v2";
import { MCP_ORGANIZATION_HEADER, toolkitSlugFromRequest } from "./auth";

const TOKEN_PREFIX = "v1fwd";
const TOKEN_VERSION = 1;
export const FORWARD_TOKEN_TTL_SECONDS = 600;

/** Span and log attribute marking a request served by v2. */
export const FORWARD_SPAN_ATTRIBUTE = "mcp.forward.v2";

const TEMPORARILY_UNAVAILABLE_MESSAGE = "Executor is temporarily unavailable - please retry";

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export interface ForwardTokenClaims {
  readonly account: string;
  readonly organization: string;
  /** Expiry, in unix seconds. */
  readonly exp: number;
  /** The v1 toolkit row id and the v2 connection id, for a toolkit URL. */
  readonly toolkit?: { readonly id: string; readonly connection: string };
}

export const mintForwardToken = async (
  secret: string,
  claims: ForwardTokenClaims,
): Promise<string> => {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        v: TOKEN_VERSION,
        account: claims.account,
        organization: claims.organization,
        exp: claims.exp,
        ...(claims.toolkit
          ? { toolkit: claims.toolkit.id, connection: claims.toolkit.connection }
          : {}),
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${TOKEN_PREFIX}.${payload}`),
  );
  return `${TOKEN_PREFIX}.${payload}.${base64Url(new Uint8Array(signature))}`;
};

/** The v2 connection that stands for a v1 toolkit in a v2 organization. */
export const toolkitConnectionId = async (
  v2OrganizationId: string,
  toolkitRowId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify([v2OrganizationId, toolkitRowId])),
  );
  return `v1-${hex(digest).slice(0, 40)}`;
};

/** v2's MCP endpoint for a request: only the elicitation mode and toolkit connection carry over. */
export const buildV2Url = (origin: string, request: Request, connection?: string): URL => {
  const url = new URL("/mcp", origin);
  const mode = readElicitationMode(request);
  if (mode !== "model") url.searchParams.set("elicitation_mode", mode);
  if (connection !== undefined) url.searchParams.set("connection", connection);
  return url;
};

// Credentials and v1's own routing are replaced by the forwarding token, so
// they never reach v2. Everything else (content negotiation, the MCP session
// and protocol headers, trace context) is copied.
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "origin",
  "host",
  MCP_ORGANIZATION_HEADER,
  EXECUTOR_ORG_SELECTOR_HEADER,
]);

// v1's internal headers (the verified identity the worker stamps for its own
// session Durable Objects, org write access) are all under this prefix.
const INTERNAL_HEADER_PREFIX = "x-executor-";

export const forwardHeaders = (source: Headers, token: string): Headers => {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (DROPPED_HEADERS.has(name) || name.startsWith(INTERNAL_HEADER_PREFIX)) continue;
    headers.append(name, value);
  }
  headers.set("authorization", `Bearer ${token}`);
  return headers;
};

const unavailableResponse = (): Response =>
  jsonRpcErrorBody(503, -32001, TEMPORARILY_UNAVAILABLE_MESSAGE, {
    retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
  });

/**
 * v2's answer, relayed as it is, except that v2 never gets to start an OAuth
 * flow with the client: its challenge is dropped, and a 401 (v2 refused our
 * forwarding credential, which the client cannot fix) becomes a retryable 503.
 */
export const relayV2Response = (
  response: Response,
  log: (event: object, cause?: unknown) => void,
): Response => {
  if (response.status === 401) {
    void response.body?.cancel();
    log({ event: "mcp_v2_forward_credential_refused", status: 401 });
    return unavailableResponse();
  }
  if (!response.headers.has("www-authenticate")) return response;
  const headers = new Headers(response.headers);
  headers.delete("www-authenticate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const PASSTHROUGH_MOVED_MESSAGE =
  "This workspace has moved to Executor v2, which has no passthrough mode. Remove mode=passthrough from the MCP URL.";

export const TOOLKIT_NOT_FOUND_MESSAGE = "Toolkit not found";

/** The bindings forwarding needs; absent in workers that do not forward. */
export interface V2ForwardEnv {
  readonly V2_MCP?: { fetch: (request: Request) => Promise<Response> };
  readonly V2_MCP_ORIGIN?: string;
  readonly V2_MCP_FORWARD_SECRET?: string;
}

export interface V2ForwardPrincipal {
  readonly accountId: string;
  readonly organizationId: string;
  readonly movedToV2?: MovedToV2;
}

export interface V2ForwardDeps {
  /** Resolves a toolkit slug to its v1 row id for this caller and org, or null when unknown. */
  readonly resolveToolkitRowId: (
    organizationId: string,
    accountId: string,
    slug: string,
  ) => Promise<string | null>;
  /** Current time in unix seconds. */
  readonly nowSeconds?: () => number;
  readonly log?: (event: object, cause?: unknown) => void;
}

const defaultLog = (event: object, cause?: unknown): void =>
  cause === undefined
    ? console.warn(JSON.stringify(event))
    : console.warn(JSON.stringify(event), cause);

/**
 * Forward `request` to v2 for a principal whose organization has moved.
 * Returns the response to send the client; never touches v1 session state.
 */
export const forwardToV2 = async (
  request: Request,
  principal: V2ForwardPrincipal,
  moved: MovedToV2,
  env: V2ForwardEnv,
  deps: V2ForwardDeps,
): Promise<Response> => {
  const log = deps.log ?? defaultLog;

  if (readToolMode(request) === "passthrough") {
    return jsonRpcErrorBody(400, -32600, PASSTHROUGH_MOVED_MESSAGE);
  }

  const { V2_MCP: binding, V2_MCP_ORIGIN: origin, V2_MCP_FORWARD_SECRET: secret } = env;
  if (!binding || !origin || !secret) {
    log({ event: "mcp_v2_forward_unconfigured", hasBinding: !!binding, hasOrigin: !!origin });
    return unavailableResponse();
  }

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: the toolkit lookup, token signing and the service binding reject with plain platform errors; every one of them is a retryable 503, never a fallback to v1
  try {
    const slug = toolkitSlugFromRequest(request);
    let toolkit: ForwardTokenClaims["toolkit"];
    if (slug !== null) {
      const rowId = await deps.resolveToolkitRowId(
        principal.organizationId,
        principal.accountId,
        slug,
      );
      if (rowId === null) return jsonRpcErrorBody(404, -32001, TOOLKIT_NOT_FOUND_MESSAGE);
      toolkit = { id: rowId, connection: await toolkitConnectionId(moved.v2OrganizationId, rowId) };
    }

    const nowSeconds = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const token = await mintForwardToken(secret, {
      account: principal.accountId,
      organization: principal.organizationId,
      exp: nowSeconds + FORWARD_TOKEN_TTL_SECONDS,
      ...(toolkit ? { toolkit } : {}),
    });

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const forwarded = new Request(buildV2Url(origin, request, toolkit?.connection), {
      method: request.method,
      headers: forwardHeaders(request.headers, token),
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    } as RequestInit);

    return relayV2Response(await binding.fetch(forwarded), log);
  } catch (error) {
    log({ event: "mcp_v2_forward_failed" }, error);
    return unavailableResponse();
  }
};
