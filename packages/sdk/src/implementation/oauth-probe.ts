/** Header-only OAuth discovery for resources that advertise auth on GET or MCP initialization. */
import { Effect } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import { bearerResourceMetadata } from "./oauth-challenge.ts";

/**
 * Probe an already policy-checked endpoint with the host's checked HTTP client.
 * Never follow redirects or invoke tools. Release streaming bodies and any probe session.
 * An unauthorized response without a Bearer metadata challenge does not imply OAuth.
 */
export const probeOAuthChallenge = (endpoint: string | URL, client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const get = yield* Effect.scoped(
      HttpClient.withScope(client)
        .get(endpoint, {
          headers: { accept: "application/json, text/event-stream" },
        })
        .pipe(
          Effect.map((response) => ({
            status: response.status,
            resourceMetadata: bearerResourceMetadata(response.headers["www-authenticate"]),
          })),
        ),
    );
    if (get.resourceMetadata !== undefined || ![401, 403, 405].includes(get.status)) return get;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* HttpClient.withScope(client).post(endpoint, {
          headers: { accept: "application/json, text/event-stream" },
          body: HttpBody.jsonUnsafe({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "executor-auth-probe", version: "1.0.0" },
            },
          }),
        });
        const session = response.headers["mcp-session-id"];
        if (response.status >= 200 && response.status < 300 && session !== undefined) {
          // Initialization can allocate a public MCP session even though we need only its headers.
          yield* Effect.addFinalizer(() =>
            Effect.scoped(
              HttpClient.withScope(client).del(endpoint, {
                headers: { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" },
              }),
            ).pipe(Effect.timeout("1 second"), Effect.ignore),
          );
        }
        return {
          status: response.status,
          resourceMetadata: bearerResourceMetadata(response.headers["www-authenticate"]),
        };
      }),
    );
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("10 seconds"),
  );
