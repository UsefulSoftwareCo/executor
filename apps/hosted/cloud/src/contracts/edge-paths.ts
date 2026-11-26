export const accountOAuthStatePrefix = "x2.";

import { clientMetadataDocumentPath } from "@executor-js/hosted-server/oauth-client-metadata";
import { Option } from "effect";
import {
  agentSkills,
  matchesSitePattern,
  siteFiles,
  sitePages,
  v1SiteFiles,
  v1SitePages,
} from "./site-paths.ts";

export interface EdgeForward {
  readonly rule: string;
  readonly matches: (url: URL) => boolean;
}

const exact = (path: string): EdgeForward => ({
  rule: path,
  matches: (url) => url.pathname === path,
});

const site = (pattern: `/${string}`): EdgeForward => ({
  rule: pattern,
  matches: (url) => matchesSitePattern(pattern, url.pathname),
});

export interface SiteTelemetryPaths {
  readonly analyticsProxy: Option.Option<string>;
  readonly errorTunnel: Option.Option<string>;
}

export const productionSiteTelemetry = {
  analyticsProxy: "/api/00e2e1f082a6ef17",
  errorTunnel: "/api/fd6fab1fbb4883e1/submit",
} as const;

export const edgeForwardsFor = (telemetry: SiteTelemetryPaths): ReadonlyArray<EdgeForward> => [
  ...routedEdgeForwards,
  ...Option.toArray(telemetry.analyticsProxy).map((root): EdgeForward => ({
    rule: `${root}/*`,
    matches: (url) => url.pathname.startsWith(`${root}/`),
  })),
  ...Option.toArray(telemetry.errorTunnel).map(exact),
];

const routedEdgeForwards: ReadonlyArray<EdgeForward> = [
  // Issuer metadata: served on the issuer's own origin, never redirected. Only the RFC 8414
  // document: with the JWT plugin disabled, Better Auth publishes no OpenID configuration.
  exact("/.well-known/oauth-authorization-server/api/auth"),
  {
    rule: "/api/auth/callback/<provider>",
    matches: (url) => /^\/api\/auth\/callback\/[^/]+$/.test(url.pathname),
  },
  {
    rule: `/api/oauth/callback, when state starts with ${accountOAuthStatePrefix}`,
    matches: (url) =>
      url.pathname === "/api/oauth/callback" &&
      (url.searchParams.get("state") ?? "").startsWith(accountOAuthStatePrefix),
  },
  exact(clientMetadataDocumentPath),
  { rule: "/git/*", matches: (url) => url.pathname.startsWith("/git/") },
  { rule: "/ (without a v1 session)", matches: (url) => url.pathname === "/" },
  ...sitePages.filter((page) => !v1SitePages.includes(page)).map(site),
  ...siteFiles.filter((file) => !v1SiteFiles.includes(file)).map(site),
  site(agentSkills),
];

export const forwardsToV2 = (forwards: ReadonlyArray<EdgeForward>, url: URL) =>
  forwards.some((forward) => forward.matches(url));
