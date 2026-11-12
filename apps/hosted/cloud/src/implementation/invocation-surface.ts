/**
 * What an HTTP invocation of a Cloud Worker served, for its `cloudflare.invocation` record: the
 * role of the host the request was sent to, the part of the product its path belongs to and the
 * kind of client that sent it. Each is one of a closed set. The URL and the user agent are read
 * only to choose them and are never recorded.
 */
import { Option } from "effect";
import { isBrowserPage, isMcpPath } from "../contracts/browser-pages.ts";
import { retainedAssetFolders } from "../contracts/retained-assets.ts";
import { agentSkills, isSitePage, matchesSitePattern, siteFiles } from "../contracts/site-paths.ts";
import type { CloudHosts } from "../infrastructure/stage.ts";
import { hostRoleOf } from "./host-roles.ts";

type RouteGroup =
  | "mcp"
  | "api"
  | "webhooks"
  | "telemetry"
  | "auth"
  | "document"
  | "assets"
  | "internal"
  | "other";

/** Sign-in, Executor's OAuth server and the OAuth sign-ins that connect accounts. */
const authPath = (pathname: string) =>
  pathname.startsWith("/api/auth/") ||
  pathname.startsWith("/api/oauth/") ||
  pathname.startsWith("/.well-known/oauth-authorization-server") ||
  pathname === "/oauth/client-metadata.json" ||
  pathname === "/api/entry" ||
  pathname === "/api/v1-handoff";

/** The site's analytics proxy and error tunnel, at a random 16-hex-digit path under `/api`. */
const siteTelemetryPath = /^\/api\/[0-9a-f]{16}\//;

/**
 * The part of the product a path belongs to, `other` for a path in none of them. Only Executor's
 * `/_executor/` namespace is known on a host that is not one of this deployment's own, such as an
 * app's domain or the upstream of an app's outbound request; every other path there is `other`.
 */
const routeGroup = (pathname: string, ownHost: boolean): RouteGroup => {
  if (pathname.startsWith("/_executor/")) {
    if (pathname.startsWith("/_executor/api/telemetry/")) return "telemetry";
    if (pathname.startsWith("/_executor/assets/")) return "assets";
    return "api";
  }
  if (!ownHost) return "other";
  if (pathname.startsWith("/api/webhooks/")) return "webhooks";
  if (pathname.startsWith("/api/internal/") || pathname === "/health") return "internal";
  if (pathname.startsWith("/api/telemetry/") || siteTelemetryPath.test(pathname))
    return "telemetry";
  if (authPath(pathname)) return "auth";
  // API discovery shares the protected-resource prefix with MCP's.
  if (pathname.startsWith("/.well-known/oauth-protected-resource/api")) return "api";
  if (isMcpPath(pathname)) return "mcp";
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/openapi.json" ||
    pathname.startsWith("/git/")
  )
    return "api";
  if (
    retainedAssetFolders.some((folder) => pathname.startsWith(`/${folder}/`)) ||
    siteFiles.some((pattern) => matchesSitePattern(pattern, pathname))
  )
    return "assets";
  if (isBrowserPage(pathname) || isSitePage(pathname) || matchesSitePattern(agentSkills, pathname))
    return "document";
  return "other";
};

/**
 * Client families, matched in order against the user agent, most by the product it starts with.
 * The names follow `auth.token.client_family` where a client is in both. Agents that act for a
 * person inside a browser-shaped agent string (`ChatGPT-User`, `Claude-User`) come before browsers
 * and bots.
 * User agents are self-declared, so this says what a client calls itself, never who it is.
 */
const clientFamilies = [
  // Codex's MCP client, and OpenAI's connector client when Codex runs it.
  ["codex", /^codex|^openai-mcp\/\S+ \(Codex\)/i],
  ["chatgpt", /^openai-(?:mcp|connectors)\b|\bChatGPT-User\b/i],
  // Claude Code in its CLI, SDKs, desktop app and editor extensions.
  ["claude-code", /^claude-code\//i],
  // Claude's connectors for claude.ai and the Claude apps.
  ["claude-ai", /\bClaude-User\b/i],
  ["cursor", /^Cursor\//i],
  ["opencode", /^opencode\//i],
  // Executor's own requests: apps, MCP sources and skills reads, and its telemetry exporters.
  ["executor", /^(?:Executor|executor-skills)$|^effect-opentelemetry-/],
  ["bot", /bot\b|crawl|spider|slurp|facebookexternalhit/i],
  ["browser", /^(?:Mozilla|Opera)\//],
  ["cli", /^(?:curl|Wget|HTTPie|xh|PowerShell|PostmanRuntime|insomnia)\//i],
  // An HTTP library or runtime's default agent: an SDK or script that names no client.
  [
    "sdk",
    /^(?:node|undici|Bun|Deno|axios|node-fetch|got|python-|aiohttp|httpx|Go-http-client|okhttp|Java|Apache-HttpClient|reqwest|fasthttp|Dart|RestSharp|Ruby|Faraday)\b/i,
  ],
] as const;
type ClientFamily = (typeof clientFamilies)[number][0] | "none" | "other";

/** `none` for a request without a user agent; `other` for one that names no known client. */
const clientFamily = (userAgent: string | undefined): ClientFamily => {
  if (userAgent === undefined || userAgent.trim() === "") return "none";
  return clientFamilies.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "other";
};

/** The surface attributes of one HTTP invocation, from its request's URL and user agent. */
export const invocationSurface = (
  hosts: Option.Option<CloudHosts>,
  request: { readonly url?: string | undefined; readonly userAgent?: string | undefined },
) => {
  const url = request.url === undefined ? null : URL.parse(request.url);
  const role = Option.match(hosts, {
    onNone: () => "other" as const,
    onSome: (layout) => hostRoleOf(layout, url?.host),
  });
  return {
    "executor.host_role": role,
    "executor.route.group": url === null ? "other" : routeGroup(url.pathname, role !== "other"),
    "executor.client.family": clientFamily(request.userAgent),
  };
};
