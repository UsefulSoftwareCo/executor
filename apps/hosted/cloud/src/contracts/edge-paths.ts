/**
 * The requests v1's edge on `executor.sh` forwards to v2 through its service binding, with the
 * original URL (`notes/cloud-domains.md`). v1 owns every other path. A test stage's forwarding
 * Worker forwards exactly these, v2's edge router serves them, and production's list is the
 * contract v1 implements.
 */

/**
 * Every connected-account sign-in v2 starts carries this at the start of its OAuth `state`. v1's
 * edge forwards a callback on `executor.sh/api/oauth/callback` to v2 only when its state starts
 * with it, and handles every other one itself. A random state is base64url and never has a dot.
 */
export const accountOAuthStatePrefix = "x2.";

import { Option } from "effect";
import {
  agentSkills,
  matchesSitePattern,
  siteFiles,
  sitePages,
  v1SiteFiles,
  v1SitePages,
  type SitePattern,
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
  // Git smart HTTP for app repositories.
  { rule: "/git/*", matches: (url) => url.pathname.startsWith("/git/") },
  // The site: the homepage for visitors without a v1 session, its pages, their files and the
  // agent skills index. v1 reserves the `apps` and `experiments` organization slugs for them.
  { rule: "/ (without a v1 session)", matches: (url) => url.pathname === "/" },
  ...sitePages.filter((page) => !v1SitePages.includes(page)).map(site),
  ...siteFiles.filter((file) => !v1SiteFiles.includes(file)).map(site),
  site(agentSkills),
];

/**
 * Production's forwards: the contract v1's edge implements. `edge-contract.json` publishes it
 * with example requests (`scripts/edge-contract.ts`); v1 tests its edge against a pinned copy.
 */
export const productionEdgeForwards = edgeForwardsFor({
  analyticsProxy: Option.some(productionSiteTelemetry.analyticsProxy),
  errorTunnel: Option.some(productionSiteTelemetry.errorTunnel),
});

/**
 * Forwarded site pages that match only themselves, such as `/pricing`. v1's edge answers a `GET`
 * or `HEAD` for one's slashed form (`/pricing/`) with a 308 to the page, query kept, as the site's
 * own build does on v2's hosts (`scripts/build-site.ts`), and forwards that. Pages with a
 * forwarded `/x/*` already forward their slashed form; deeper paths stay v1's.
 */
export const slashRedirectedSitePages: ReadonlyArray<SitePattern> = sitePages.filter(
  (page) =>
    !page.endsWith("/*") &&
    !page.includes(".") &&
    !v1SitePages.includes(page) &&
    !sitePages.includes(`${page}/*`),
);

/** Whether `forwards` include `url`. */
export const forwardsToV2 = (forwards: ReadonlyArray<EdgeForward>, url: URL) =>
  forwards.some((forward) => forward.matches(url));

/**
 * What v2 answers on the edge whatever the deployment's telemetry: every forward, and any
 * `/api/<16 hex>/...` path, which only the telemetry handlers answer and only at their own path.
 */
export const servedOnEdge = (url: URL) =>
  forwardsToV2(routedEdgeForwards, url) || /^\/api\/[0-9a-f]{16}\//.test(url.pathname);
