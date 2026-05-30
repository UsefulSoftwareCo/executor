import { HttpServerResponse } from "effect/unstable/http";

import { jsonRpcErrorBody } from "@executor-js/host-mcp";

export const CORS_ALLOW_ORIGIN = { "access-control-allow-origin": "*" } as const;

type UnauthorizedAuth = {
  readonly reason: "missing_bearer" | "invalid_token";
  readonly description?: string;
};

const quoteAuthParam = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const bearerChallenge = (auth: UnauthorizedAuth, protectedResourceMetadataUrl: string) => {
  const params =
    auth.reason === "missing_bearer"
      ? [`resource_metadata=${quoteAuthParam(protectedResourceMetadataUrl)}`]
      : [
          'error="invalid_token"',
          `error_description=${quoteAuthParam(
            auth.description ?? "The access token is invalid or expired",
          )}`,
          `resource_metadata=${quoteAuthParam(protectedResourceMetadataUrl)}`,
        ];

  return `Bearer ${params.join(", ")}`;
};

/**
 * The cloud edge's JSON-RPC error `Response` (CORS-on — it crosses the browser
 * boundary). Delegates to the canonical `jsonRpcErrorBody` renderer; the body
 * is `{jsonrpc:"2.0",error:{code,message},id:null}` with `content-type` +
 * `access-control-allow-origin: *`, byte-identical to the prior local copy.
 */
export const jsonRpcWebResponse = (status: number, code: number, message: string) =>
  jsonRpcErrorBody(status, code, message);

export const unauthorized = (auth: UnauthorizedAuth, protectedResourceMetadataUrl: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        ...CORS_ALLOW_ORIGIN,
        "www-authenticate": bearerChallenge(auth, protectedResourceMetadataUrl),
      },
    },
  );
