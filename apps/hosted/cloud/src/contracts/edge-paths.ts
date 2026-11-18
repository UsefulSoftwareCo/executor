/**
 * The requests v1's edge on `executor.sh` forwards to v2 through its service binding, with the
 * original URL (`notes/cloud-domains.md`). v1 owns every other path. A test stage's forwarding
 * Worker forwards exactly these and v2's edge router serves them. Production no longer goes
 * through v1's edge: v2's gateway serves `executor.sh` itself (`notes/v1-shutdown.md`).
 */

/**
 * Every connected-account sign-in v2 starts carries this at the start of its OAuth `state`. v1's
 * edge forwards a callback on `executor.sh/api/oauth/callback` to v2 only when its state starts
 * with it, and handles every other one itself. A random state is base64url and never has a dot.
 */
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

/** One forwarded request shape, with the form v1's edge documents it in. */
export interface EdgeForward {
  /** How v1's edge writes the rule. */
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

/**
 * The site's browser telemetry paths on a deployment: its PostHog proxy root, `/api/<16 hex>`
 * (requests below it are forwarded, the root itself is not), and its Sentry tunnel,
 * `/api/<16 hex>/submit`, forwarded exactly. Each is a retained random output of the stage's
 * telemetry stack, `proxyPath` of `executor-next-posthog` and `browserTunnel` of
 * `executor-next-sentry`. None where the stage has that telemetry off.
 */
export interface SiteTelemetryPaths {
  readonly analyticsProxy: Option.Option<string>;
  readonly errorTunnel: Option.Option<string>;
}

/**
 * Production's telemetry paths, the `v2` stage's outputs. v1 lists the same two values, and a
 * `v2` deploy whose outputs differ fails (`infrastructure/posthog.ts`, `infrastructure/sentry.ts`).
 */
export const productionSiteTelemetry = {
  analyticsProxy: "/api/00e2e1f082a6ef17",
  errorTunnel: "/api/fd6fab1fbb4883e1/submit",
} as const;

/** Every request v1 forwards to v2 for a deployment with these telemetry paths. */
export const edgeForwardsFor = (telemetry: SiteTelemetryPaths): ReadonlyArray<EdgeForward> => [
  ...routedEdgeForwards,
  ...Option.toArray(telemetry.analyticsProxy).map((root): EdgeForward => ({
    rule: `${root}/*`,
    matches: (url) => url.pathname.startsWith(`${root}/`),
  })),
  ...Option.toArray(telemetry.errorTunnel).map(exact),
];

/** Everything forwarded except the telemetry paths, which differ between deployments. */
const routedEdgeForwards: ReadonlyArray<EdgeForward> = [
  // Issuer metadata: served on the issuer's own origin, never redirected. Only the RFC 8414
  // document: with the JWT plugin disabled, Better Auth publishes no OpenID configuration.
  exact("/.well-known/oauth-authorization-server/api/auth"),
  // Social sign-in returns, bounced to the browser origin. v1's own WorkOS callback is
  // `/api/auth/callback` without a provider segment.
  {
    rule: "/api/auth/callback/<provider>",
    matches: (url) => /^\/api\/auth\/callback\/[^/]+$/.test(url.pathname),
  },
  // Connected-account sign-in returns for v2's sign-ins, bounced to the browser origin.
  {
    rule: `/api/oauth/callback, when state starts with ${accountOAuthStatePrefix}`,
    matches: (url) =>
      url.pathname === "/api/oauth/callback" &&
      (url.searchParams.get("state") ?? "").startsWith(accountOAuthStatePrefix),
  },
  // The OAuth client metadata document connected-account sign-ins name as their client ID, on the
  // edge's origin like their callback. v1's own document is `/oauth/client-id-metadata.json`.
  exact(clientMetadataDocumentPath),
  // Git smart HTTP for app repositories.
  { rule: "/git/*", matches: (url) => url.pathname.startsWith("/git/") },
  // The site: the homepage for visitors without a v1 session, its pages, their files and the
  // agent skills index. v1 reserves the `apps` and `experiments` organization slugs for them.
  { rule: "/ (without a v1 session)", matches: (url) => url.pathname === "/" },
  ...sitePages.filter((page) => !v1SitePages.includes(page)).map(site),
  ...siteFiles.filter((file) => !v1SiteFiles.includes(file)).map(site),
  site(agentSkills),
];

/** Whether `forwards` include `url`. */
export const forwardsToV2 = (forwards: ReadonlyArray<EdgeForward>, url: URL) =>
  forwards.some((forward) => forward.matches(url));
