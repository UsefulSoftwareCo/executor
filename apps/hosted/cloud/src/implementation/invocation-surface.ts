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

const authPath = (pathname: string) =>
  pathname.startsWith("/api/auth/") ||
  pathname.startsWith("/api/oauth/") ||
  pathname.startsWith("/.well-known/oauth-authorization-server") ||
  pathname === "/oauth/client-metadata.json" ||
  pathname === "/api/entry" ||
  pathname === "/api/v1-handoff";

const siteTelemetryPath = /^\/api\/[0-9a-f]{16}\//;

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

const clientFamilies = [
  ["codex", /^codex|^openai-mcp\/\S+ \(Codex\)/i],
  ["chatgpt", /^openai-(?:mcp|connectors)\b|\bChatGPT-User\b/i],
  ["claude-code", /^claude-code\//i],
  ["claude-ai", /\bClaude-User\b/i],
  ["cursor", /^Cursor\//i],
  ["opencode", /^opencode\//i],
  ["executor", /^(?:Executor|executor-skills)$|^effect-opentelemetry-/],
  ["bot", /bot\b|crawl|spider|slurp|facebookexternalhit/i],
  ["browser", /^(?:Mozilla|Opera)\//],
  ["cli", /^(?:curl|Wget|HTTPie|xh|PowerShell|PostmanRuntime|insomnia)\//i],
  [
    "sdk",
    /^(?:node|undici|Bun|Deno|axios|node-fetch|got|python-|aiohttp|httpx|Go-http-client|okhttp|Java|Apache-HttpClient|reqwest|fasthttp|Dart|RestSharp|Ruby|Faraday)\b/i,
  ],
] as const;
type ClientFamily = (typeof clientFamilies)[number][0] | "none" | "other";

const clientFamily = (userAgent: string | undefined): ClientFamily => {
  if (userAgent === undefined || userAgent.trim() === "") return "none";
  return clientFamilies.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "other";
};

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
