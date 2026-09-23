/** Remote MCP imports retain ordinary source. Catalogs stay live and account-specific. */
import { Effect } from "effect";
import { probeOAuthChallenge } from "@executor-js/sdk/core";
import { type HttpClient } from "effect/unstable/http";
import { generateRemoteApp } from "@executor-js/app-templates";
import { parseDestination, type HostEgress, type UrlPolicy } from "@executor-js/utils/url-policy";
import {
  CatalogImportFailed,
  type CatalogEntry,
  type McpImportAuth,
} from "../contracts/catalog.ts";

const fail = (code: CatalogImportFailed["code"], reason: string) =>
  new CatalogImportFailed({ code, reason });

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
      // Live probes run from the host process, so the destination policy applies to them.
      parseDestination(url.href, policy) === undefined
    ) {
      return yield* fail(
        "mcp_url",
        "Use an HTTP MCP server URL without embedded credentials or placeholders.",
      );
    }
    return url.href;
  });

/** Inspect only response headers and release streams; an auth error alone does not establish OAuth support. */
const advertisesOAuth = (url: string, client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const response = yield* probeOAuthChallenge(url, client);
    if (
      (response.status < 200 || response.status >= 300) &&
      ![401, 403, 405].includes(response.status)
    ) {
      return yield* fail(
        "mcp_probe",
        "Could not check this MCP server's sign-in methods. Try again or choose a method explicitly.",
      );
    }
    yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
    return response.resourceMetadata !== undefined;
  }).pipe(
    Effect.mapError((error) =>
      fail(
        error._tag === "TimeoutError" ? "mcp_timeout" : "mcp_probe",
        "Could not check this MCP server's sign-in methods. Try again or choose a method explicitly.",
      ),
    ),
  );

function authentication(
  entry: CatalogEntry,
  choice: McpImportAuth,
  url: string,
  client: HttpClient.HttpClient,
) {
  if (choice !== "auto") return Effect.succeed(choice);
  const kind = entry.auth?.kind;
  if (kind === "oauth") return Effect.succeed("oauth" as const);
  if (kind === "mixed") return Effect.succeed("mixed" as const);
  return Effect.gen(function* () {
    // Catalog hints may be incomplete. Preserve API-key support while adding live OAuth support.
    if (yield* advertisesOAuth(url, client))
      return kind === "api_key" ? ("mixed" as const) : ("oauth" as const);
    if (kind === "api_key") return "apiKey" as const;
    if (kind === "none" || kind === "public") return "none" as const;
    const { McpError, probeMcp } = yield* Effect.promise(
      () => import("@executor-js/app-templates/probe"),
    );
    return yield* probeMcp({ url, timeoutMs: 10_000 }).pipe(
      Effect.as("none" as const),
      Effect.mapError((error) =>
        fail(
          error instanceof McpError && error.reason === "unauthorized"
            ? "mcp_auth_missing"
            : error instanceof McpError && error.reason === "timeout"
              ? "mcp_timeout"
              : "mcp_discovery",
          error instanceof McpError && error.reason === "unauthorized"
            ? "This MCP server requires authentication but did not advertise OAuth. Choose a sign-in method and try again."
            : "Could not discover this MCP server. Check its URL and try again.",
        ),
      ),
    );
  });
}

/** Generate a provider only when needed; credentials are never embedded in retained files. */
export const generateMcpApp = (
  entry: CatalogEntry,
  egress: HostEgress,
  choice: McpImportAuth = "auto",
) =>
  Effect.gen(function* () {
    if (entry.kind !== "mcp") return yield* fail("mcp_entry", "Choose an MCP catalog entry.");
    const url = yield* mcpUrl(entry.connectUrl, egress.policy);
    const discovery = yield* mcpUrl(entry.oauthDiscoveryUrl ?? url, egress.policy);
    const auth = yield* authentication(entry, choice, discovery, egress.client);
    let header = { name: "Authorization", prefix: "Bearer " };
    if ((auth === "apiKey" || auth === "mixed") && entry.auth?.header !== undefined) {
      const parsed = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+):\s*([^{}\r\n]*)\{[A-Za-z0-9_]+\}$/.exec(
        entry.auth.header,
      );
      if (!parsed?.[1] || parsed[2] === undefined)
        return yield* fail(
          "mcp_auth_header",
          "This MCP server needs a custom authentication helper.",
        );
      header = { name: parsed[1], prefix: parsed[2] };
    }
    return yield* generateRemoteApp(entry.name, url, "mcp", {
      ...(auth === "oauth" || auth === "mixed" ? { oauth: { discover: discovery } } : {}),
      ...(auth === "apiKey" || auth === "mixed"
        ? { apiKey: { header: header.name, prefix: header.prefix } }
        : {}),
    });
  }).pipe(Effect.catchTag("TemplateError", (error) => Effect.fail(fail(error.code, error.reason))));
