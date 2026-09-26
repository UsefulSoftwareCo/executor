/** Remote MCP imports retain ordinary source. Catalogs stay live and account-specific. */
import { Effect } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import { discoversResourceOAuth } from "@executor-js/sdk/core";
import { generateMcpSource } from "@executor-js/app-templates";
import { parseDestination, type HostEgress, type UrlPolicy } from "@executor-js/utils/url-policy";
import { CatalogImportFailed } from "../contracts/catalog.ts";

const fail = (code: CatalogImportFailed["code"], reason: string) =>
  new CatalogImportFailed({ code, reason });

const setupRequired = () =>
  fail(
    "agent_setup_required",
    "Executor could not confirm that this MCP server uses OAuth or needs no sign-in. Copy the setup prompt and add it with your agent.",
  );

const mcpUrl = (value: string | undefined, policy: UrlPolicy) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(value ?? ""),
      catch: () => fail("mcp_url", "This MCP entry has no valid server URL."),
    });
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      /[{}]/.test(url.href) ||
      // Stored endpoints must satisfy the importing host's destination policy.
      parseDestination(url.href, policy) === undefined
    ) {
      return yield* fail(
        "mcp_url",
        "Use an HTTP MCP server URL without embedded credentials or placeholders.",
      );
    }
    return url.href;
  });

const protocolVersion = "2025-11-25";

/**
 * Initialize without credentials under the host's egress. Only a successful initialization or a
 * sign-in rejection answers the question; tools are never listed or called.
 */
const initialize = (url: string, egress: HostEgress) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = HttpClient.withScope(egress.client);
      const response = yield* client.post(url, {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.jsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "executor-import-check", version: "1.0.0" },
          },
        }),
      });
      const session = response.headers["mcp-session-id"];
      if (response.status >= 200 && response.status < 300 && session !== undefined)
        // A public server can allocate a session for this check; release it.
        yield* Effect.addFinalizer(() =>
          Effect.scoped(
            client.del(url, {
              headers: { "mcp-session-id": session, "mcp-protocol-version": protocolVersion },
            }),
          ).pipe(Effect.timeout("1 second"), Effect.ignore),
        );
      return response.status;
    }),
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.mapError(() =>
      fail("mcp_probe", "Could not reach this MCP server. Check the URL and try again."),
    ),
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        fail("mcp_timeout", "The MCP server did not respond within 10 seconds. Try again."),
      ),
    ),
  );

/**
 * Quick add accepts only servers whose connection is known: public servers, and servers that
 * reject anonymous use and advertise OAuth. Everything else is set up with an agent.
 */
const access = (url: string, discovery: string, egress: HostEgress) =>
  Effect.gen(function* () {
    const status = yield* initialize(url, egress);
    if (status >= 200 && status < 300) return "none" as const;
    if (status === 429 || status >= 500)
      return yield* fail(
        "mcp_probe",
        "The MCP server could not respond right now. Try again later.",
      );
    if (status !== 401 && status !== 403) return yield* setupRequired();
    const oauth = yield* discoversResourceOAuth(discovery, {
      httpClient: egress.client,
      urlPolicy: egress.policy,
    });
    if (!oauth) return yield* setupRequired();
    return "oauth" as const;
  }).pipe(Effect.withSpan("catalog.mcp.access"));

/** Generate source for a server whose connection method was confirmed; never embed credentials. */
export const generateMcpApp = (
  input: {
    readonly name: string;
    readonly url: string | undefined;
    readonly oauthDiscoveryUrl?: string | undefined;
  },
  egress: HostEgress,
) =>
  Effect.gen(function* () {
    const url = yield* mcpUrl(input.url, egress.policy);
    const discovery = yield* mcpUrl(input.oauthDiscoveryUrl ?? url, egress.policy);
    const method = yield* access(url, discovery, egress);
    yield* Effect.annotateCurrentSpan("catalog.mcp.auth", method);
    return yield* generateMcpSource(
      input.name,
      url,
      method === "oauth" ? { discover: discovery } : undefined,
    );
  }).pipe(Effect.catchTag("TemplateError", (error) => Effect.fail(fail(error.code, error.reason))));
