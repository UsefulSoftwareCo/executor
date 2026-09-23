/** Remote MCP imports retain ordinary source. Catalogs stay live and account-specific. */
import { Effect } from "effect";
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

/** Catalog hints configure source; live discovery belongs to account setup and app execution. */
function authentication(entry: CatalogEntry, choice: McpImportAuth) {
  if (choice !== "auto") return choice;
  const kind = entry.auth?.kind;
  if (kind === "oauth") return "oauth";
  if (kind === "mixed" || kind === "api_key") return "mixed";
  if (kind === "none" || kind === "public") return "none";
  return "setup";
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
    const auth = authentication(entry, choice);
    let header = { name: "Authorization", prefix: "Bearer " };
    if (
      (auth === "apiKey" || auth === "mixed" || auth === "setup") &&
      entry.auth?.header !== undefined
    ) {
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
      ...(auth === "oauth" || auth === "mixed" || auth === "setup"
        ? { oauth: { discover: discovery } }
        : {}),
      ...(auth === "apiKey" || auth === "mixed" || auth === "setup"
        ? { apiKey: { header: header.name, prefix: header.prefix } }
        : {}),
      ...(auth === "setup" ? { public: true } : {}),
    });
  }).pipe(Effect.catchTag("TemplateError", (error) => Effect.fail(fail(error.code, error.reason))));
