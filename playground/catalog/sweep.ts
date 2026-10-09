/**
 * Read-only sweep of public remote MCP servers through the same check quick add uses. Every
 * request is unauthenticated: initialize, tools/list and metadata GETs. It never signs in,
 * registers a client or calls a tool. Run it by hand; it is not part of CI.
 *
 * Client setup is reported for a host without a Client ID Metadata Document, like a default
 * install. Set EXECUTOR_OAUTH_CLIENT_METADATA_URL, as a host would, to report one that has it.
 */
import { detectMcpAccess, McpDetection, McpSignal } from "@executor-js/catalog";
import { httpsOnlyUrlPolicy } from "@executor-js/utils/url-policy";
import { Config, Console, Effect, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const servers = [
  ["Exa", "https://mcp.exa.ai/mcp"],
  ["GitHub", "https://api.githubcopilot.com/mcp/"],
  ["Linear", "https://mcp.linear.app/mcp"],
  ["Sentry", "https://mcp.sentry.dev/mcp"],
  ["Vercel", "https://mcp.vercel.com"],
  ["Notion", "https://mcp.notion.com/mcp"],
  ["Atlassian", "https://mcp.atlassian.com/v1/mcp"],
  ["Asana", "https://mcp.asana.com/v2/mcp"],
  ["Stripe", "https://mcp.stripe.com"],
  ["Cloudflare API", "https://mcp.cloudflare.com/mcp"],
  ["Cloudflare Bindings", "https://bindings.mcp.cloudflare.com/mcp"],
  ["PostHog", "https://mcp.posthog.com/mcp"],
  ["Context7", "https://mcp.context7.com/mcp"],
  ["DeepWiki", "https://mcp.deepwiki.com/mcp"],
  ["Hugging Face", "https://huggingface.co/mcp"],
  ["Hugging Face (login)", "https://huggingface.co/mcp?login"],
  ["Ahrefs", "https://api.ahrefs.com/mcp/mcp"],
  ["Fastmail", "https://api.fastmail.com/mcp"],
  ["Slack", "https://mcp.slack.com/mcp"],
  ["Supabase", "https://mcp.supabase.com/mcp"],
  // Microsoft Entra ID: its metadata lists no PKCE methods, but it accepts S256.
  ["Azure DevOps", "https://mcp.dev.azure.com/mcp"],
  ["Microsoft 365 Agents", "https://agent365.svc.cloud.microsoft/mcp"],
] as const;

const outcome = McpDetection.match({
  Anonymous: ({ oauth }) =>
    oauth === undefined ? "anonymous" : `anonymous, OAuth offered (${oauth})`,
  OAuth: ({ registration }) => `OAuth (${registration} client)`,
  CredentialsRequired: ({ scheme }) => `credentials required (${scheme})`,
  Undetermined: ({ reason }) => `undetermined: ${reason}`,
});

const status = (value: { readonly status?: number }) =>
  value.status === undefined ? "" : ` ${value.status}`;
const signal = McpSignal.match({
  McpRequest: (request) => {
    const named =
      request.challenge === undefined
        ? []
        : [
            request.challenge.scheme,
            ...(request.challenge.resourceMetadata ? ["resource_metadata"] : []),
            ...(request.challenge.scope ? ["scope"] : []),
          ];
    return `${request.method}${status(request)} ${request.media} ${request.answer}${named.length === 0 ? "" : ` (${named.join(" ")})`}`;
  },
  ResourceMetadata: (lookup) => `PRM ${lookup.location}${status(lookup)} ${lookup.result}`,
  AuthorizationServerMetadata: (server) =>
    [`AS ${server.issuer}${status(server)} ${server.result}`, server.document, server.registration]
      .filter((part) => part !== undefined)
      .join(" "),
});

await Effect.runPromise(
  Effect.gen(function* () {
    const host = {
      egress: {
        policy: httpsOnlyUrlPolicy,
        client: yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)),
      },
      clientMetadataUrl: yield* Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      ),
    };
    yield* Console.log("| Server | Detected | Signals |\n| --- | --- | --- |");
    const rows = yield* Effect.forEach(
      servers,
      ([name, url]) =>
        detectMcpAccess({ url, discovery: url }, host).pipe(
          Effect.map(
            (detection) =>
              `| ${name} | ${outcome(detection)} | ${detection.signals.map(signal).join("; ")} |`,
          ),
        ),
      { concurrency: 4 },
    );
    for (const row of rows) yield* Console.log(row);
  }),
);
