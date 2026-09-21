/** Remote MCP imports retain ordinary source. Catalogs stay live and account-specific. */
import { Effect } from "effect";
import { bearerResourceMetadata } from "@executor-js/sdk/core";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { generateRemoteApp } from "@executor-js/app-templates";
import { parseDestination, type HostEgress, type UrlPolicy } from "@executor-js/utils/url-policy";
import {
  CatalogImportFailed,
  type CatalogEntry,
  type McpImportAuth,
} from "../contracts/catalog.ts";

const fail = (reason: string) => new CatalogImportFailed({ reason });

const mcpUrl = (value: string | undefined, policy: UrlPolicy) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(value ?? ""),
      catch: () => fail("This MCP entry has no valid server URL."),
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
        "Use an HTTP MCP server URL without embedded credentials or placeholders.",
      );
    }
    return url.href;
  });

/** Inspect only response headers and release streams; an auth error alone does not establish OAuth support. */
const advertisesOAuth = (url: string, client: HttpClient.HttpClient) =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* HttpClient.withScope(client).get(url, {
        headers: { accept: "application/json, text/event-stream" },
      });
      if (
        (response.status < 200 || response.status >= 300) &&
        ![401, 403, 405].includes(response.status)
      ) {
        return yield* fail(
          "Could not check this MCP server's sign-in methods. Try again or choose a method explicitly.",
        );
      }
      return bearerResourceMetadata(response.headers["www-authenticate"]) !== undefined;
    }),
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("10 seconds"),
    Effect.mapError(() =>
      fail(
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
    if (entry.kind !== "mcp") return yield* fail("Choose an MCP catalog entry.");
    const url = yield* mcpUrl(entry.connectUrl, egress.policy);
    const discovery = yield* mcpUrl(entry.oauthDiscoveryUrl ?? url, egress.policy);
    const auth = yield* authentication(entry, choice, discovery, egress.client);
    let header = { name: "Authorization", prefix: "Bearer " };
    if ((auth === "apiKey" || auth === "mixed") && entry.auth?.header !== undefined) {
      const parsed = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+):\s*([^{}\r\n]*)\{[A-Za-z0-9_]+\}$/.exec(
        entry.auth.header,
      );
      if (!parsed?.[1] || parsed[2] === undefined)
        return yield* fail("This MCP server needs a custom authentication helper.");
      header = { name: parsed[1], prefix: parsed[2] };
    }
    return yield* generateRemoteApp(entry.name, url, "mcp", {
      ...(auth === "oauth" || auth === "mixed" ? { oauth: { discover: discovery } } : {}),
      ...(auth === "apiKey" || auth === "mixed"
        ? { apiKey: { header: header.name, prefix: header.prefix } }
        : {}),
    });
  }).pipe(Effect.catchTag("TemplateError", (error) => Effect.fail(fail(error.reason))));
