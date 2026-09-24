/** Translate custom import configuration to ordinary deployable source files. */
import { catalogStage } from "./diagnostics.ts";
import { Effect } from "effect";
import type { CustomAppInput } from "../contracts/imports.ts";
import { generateApp } from "./generate.ts";
import { generateMcpApp } from "./mcp.ts";
import { readApiDocument } from "./source.ts";
import { generateRemoteApp, generateStdioApp, type RemoteAuth } from "@executor-js/app-templates";
import { CatalogImportFailed, type PreparedApp } from "../contracts/catalog.ts";
import { parseDestination, type HostEgress } from "@executor-js/utils/url-policy";

/** Protocols other than OpenAPI keep every operation the service exposes. */
export const complete = ({ files }: Pick<PreparedApp, "files">): PreparedApp => ({
  files,
  skippedOperations: [],
});

/**
 * Account secrets are supplied later through the shared account connection flow. The product
 * supplies the destination policy for every host-side fetch this import performs.
 */
export const generateCustomApp = (input: CustomAppInput, egress: HostEgress) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("catalog.entry.kind", input.kind);
    if (input.kind === "mcp-stdio") return complete(yield* generateStdioApp(input));
    if (parseDestination(input.url, egress.policy) === undefined)
      return yield* new CatalogImportFailed({
        code: "destination_blocked",
        reason: "This URL is not an allowed destination. Use a public HTTPS URL and try again.",
      });
    const entry = {
      id: input.url,
      kind: input.kind,
      name: input.name,
      domain: new URL(input.url).hostname,
      description: "",
      connectUrl: input.url,
    };
    if (input.kind === "openapi") {
      if (
        input.baseUrl !== undefined &&
        parseDestination(input.baseUrl, egress.policy) === undefined
      )
        return yield* new CatalogImportFailed({
          code: "base_url_blocked",
          reason:
            "This API base URL is not an allowed destination. Use a public HTTPS URL and try again.",
        });
      const { files, skippedOperations } = yield* generateApp(
        entry,
        yield* readApiDocument(input.url, egress).pipe(catalogStage("document")),
        input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl },
      ).pipe(catalogStage("generate"));
      return { files, skippedOperations } satisfies PreparedApp;
    }
    if (input.auth.type === "auto")
      return complete(yield* generateMcpApp(entry, egress, "auto").pipe(catalogStage("mcp")));
    let auth: RemoteAuth;
    switch (input.auth.type) {
      case "none":
        auth = {};
        break;
      case "apiKey":
        auth = { apiKey: { header: input.auth.header, prefix: input.auth.prefix } };
        break;
      case "discoverOAuth":
        auth = { oauth: { discover: input.url } };
        break;
      case "oauth":
        // These endpoints are stored, not fetched here. Every OAuth request applies the host
        // destination rule at the moment it runs, under that host's own policy.
        auth = {
          oauth: {
            authorizationUrl: input.auth.authorizationUrl,
            tokenUrl: input.auth.tokenUrl,
            scopes: input.auth.scopes,
            tokenEndpointAuthMethod: "client_secret_basic",
          },
        };
        break;
    }
    return complete(yield* generateRemoteApp(input.name, input.url, input.kind, auth));
  }).pipe(
    Effect.catchTag("TemplateError", (error) =>
      Effect.fail(new CatalogImportFailed({ code: error.code, reason: error.reason })),
    ),
    catalogStage("custom"),
  );
