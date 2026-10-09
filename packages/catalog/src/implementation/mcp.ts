/** Remote MCP imports retain ordinary source. Catalogs stay live and account-specific. */
import { Effect, Match, Schema } from "effect";
import { generateMcpSource, type McpSourceAccess } from "@executor-js/app-templates";
import { parseDestination, type UrlPolicy } from "@executor-js/utils/url-policy";
import { CatalogImportFailed, type CatalogHost } from "../contracts/catalog.ts";
import { McpDetection, McpRequestSignal, McpSignal } from "../contracts/detection.ts";
import { detectMcpAccess } from "./detection.ts";

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

const agent = "Copy the setup prompt and add it with your agent.";

/** The request that decided the outcome: tools/list when it ran, otherwise initialize. */
const decidingRequest = (signals: ReadonlyArray<McpSignal>) =>
  signals.filter(Schema.is(McpRequestSignal)).at(-1);

/** Why advertised OAuth could not be used, from the last metadata lookup. */
const oauthProblem = (signals: ReadonlyArray<McpSignal>) => {
  const blocked = "an address in its OAuth settings is not allowed by this Executor instance";
  const last = signals.filter((signal) => !Schema.is(McpRequestSignal)(signal)).at(-1);
  return last === undefined
    ? "its OAuth settings could not be used"
    : McpSignal.match(last, {
        McpRequest: () => "its OAuth settings could not be used",
        ResourceMetadata: ({ result }) =>
          result === "blocked"
            ? blocked
            : result === "mismatch"
              ? "its protected-resource metadata names a different server"
              : result === "missing"
                ? "the protected-resource metadata its challenge names is missing"
                : "its protected-resource metadata is not valid",
        AuthorizationServerMetadata: ({ result }) =>
          result === "blocked"
            ? blocked
            : result === "missing"
              ? "its authorization server publishes no OAuth metadata"
              : result === "unsupported"
                ? "its authorization server does not support authorization-code sign-in with PKCE (S256)"
                : "its authorization server metadata cannot be used to prepare sign-in",
      });
};

/** Status text for the request that decided an outcome. */
const statusOf = (signals: ReadonlyArray<McpSignal>, fallback: string) => {
  const request = decidingRequest(signals);
  return request === undefined ? fallback : `HTTP ${request.status}`;
};

/** A server that rejected anonymous use and advertises no OAuth needs other credentials. */
const credentialsRequired = ({
  scheme,
  signals,
}: typeof McpDetection.cases.CredentialsRequired.Type) => {
  const challenge = Match.value(scheme).pipe(
    Match.when("bearer", () => " and a Bearer challenge"),
    Match.when("basic", () => " and a Basic challenge"),
    Match.when("other", () => " and a sign-in challenge"),
    Match.when("unspecified", () => ""),
    Match.exhaustive,
  );
  const method = decidingRequest(signals)?.method ?? "initialize";
  return {
    code: "agent_setup_required" as const,
    reason: `This MCP server needs an API key or other credentials. It rejected an anonymous ${method} request with ${statusOf(signals, "an error")}${challenge} and advertises no OAuth sign-in. ${agent}`,
  };
};

/** Why nothing could be decided. Transient causes can be retried; the rest need an agent. */
const undetermined = ({ reason, signals }: typeof McpDetection.cases.Undetermined.Type) => {
  const request = decidingRequest(signals);
  const status = statusOf(signals, "no answer");
  return Match.value(reason).pipe(
    Match.when("unavailable", () => ({
      code: "mcp_probe" as const,
      reason: "The MCP server could not respond right now. Try again later.",
    })),
    Match.when("unreachable", () => ({
      code: "mcp_probe" as const,
      reason: "Could not reach this MCP server. Check the URL and try again.",
    })),
    Match.when("timeout", () => ({
      code: "mcp_timeout" as const,
      reason: "The MCP server did not respond in time. Try again.",
    })),
    Match.when("redirected", () => ({
      code: "agent_setup_required" as const,
      reason: `This MCP server redirected the request (${status}). Use the address it redirects to, or copy the setup prompt and add it with your agent.`,
    })),
    Match.when("refused", () => ({
      code: "agent_setup_required" as const,
      reason: `This MCP server refused Executor's request with a web page (${status}) instead of an MCP or sign-in response. Its firewall may block requests from this Executor host. ${agent}`,
    })),
    Match.when("not_mcp", () => ({
      code: "agent_setup_required" as const,
      reason: `This URL did not answer an MCP initialize request (${status}${request !== undefined && request.status < 300 ? " without an initialize result" : ""}). Check that it is the server's MCP endpoint, or copy the setup prompt and add it with your agent.`,
    })),
    Match.when("initialize_error", () => ({
      code: "agent_setup_required" as const,
      reason: `This MCP server returned an error to an anonymous initialize request. ${agent}`,
    })),
    Match.when("tools_error", () => ({
      code: "agent_setup_required" as const,
      reason: `This MCP server initialized without credentials but did not list its tools (${status}). ${agent}`,
    })),
    Match.when("oauth_unusable", () => ({
      code: "agent_setup_required" as const,
      reason: `This MCP server requires sign-in and advertises OAuth, but ${oauthProblem(signals)}. ${agent}`,
    })),
    Match.exhaustive,
  );
};

/**
 * Generate source for a server whose connection was confirmed; never embed credentials. Public
 * servers and servers whose OAuth an account connection can complete are added directly. Every
 * other outcome fails with a reason naming the signals that decided it, and the detection itself.
 */
export const generateMcpApp = (
  input: {
    readonly name: string;
    readonly url: string | undefined;
    readonly oauthDiscoveryUrl?: string | undefined;
  },
  host: CatalogHost,
) =>
  Effect.gen(function* () {
    const url = yield* mcpUrl(input.url, host.egress.policy);
    const discovery = yield* mcpUrl(input.oauthDiscoveryUrl ?? url, host.egress.policy);
    const detection = yield* detectMcpAccess({ url, discovery }, host);
    type Decision = Effect.Effect<McpSourceAccess, CatalogImportFailed>;
    const failed = (failure: {
      readonly code: CatalogImportFailed["code"];
      readonly reason: string;
    }): Decision => Effect.fail(new CatalogImportFailed({ ...failure, detection }));
    const access = yield* McpDetection.match(detection, {
      OAuth: (): Decision => Effect.succeed({ kind: "oauth", discover: discovery }),
      Anonymous: ({ oauth }): Decision =>
        Effect.succeed({
          kind: "public",
          ...(oauth === undefined ? {} : { offersOAuth: { discover: discovery } }),
        }),
      CredentialsRequired: (required) => failed(credentialsRequired(required)),
      Undetermined: (unknown) => failed(undetermined(unknown)),
    });
    return yield* generateMcpSource(input.name, url, access);
  }).pipe(Effect.catchTag("TemplateError", (error) => Effect.fail(fail(error.code, error.reason))));
