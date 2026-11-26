import { clientMetadataLogoPath } from "@executor-js/hosted-server/oauth-client-metadata";

export type SitePattern = `/${string}`;

export const sitePages: ReadonlyArray<SitePattern> = [
  "/home",
  "/pricing",
  "/pricing.md",
  "/index.md",
  "/setup-prompt.md",
  "/llms.txt",
  "/about-executor",
  "/google-workspace",
  "/google-oauth",
  "/privacy",
  "/terms",
  "/blog",
  "/blog/*",
  "/docs",
  "/docs/*",
  "/apps",
  "/apps/*",
  "/experiments/*",
];

export const v1SitePages: ReadonlyArray<SitePattern> = ["/google-oauth", "/privacy", "/terms"];

/**
 * How to report a security problem (RFC 9116), from the site's assets. Listed in `siteFiles`
 * for the edge; the browser and MCP hosts serve it too, as the file's `Canonical` lines say.
 */
export const securityTxt: SitePattern = "/.well-known/security.txt";

export const siteFiles: ReadonlyArray<SitePattern> = [
  "/_astro/*",
  "/authors/*",
  "/favicon-32.png",
  "/favicon-192.png",
  "/apple-touch-icon.png",
  "/og-image.png",
  "/pattern-graph-paper.svg",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemap-marketing.xml",
  securityTxt,
  clientMetadataLogoPath,
];

export const v1SiteFiles: ReadonlyArray<SitePattern> = [
  "/favicon-32.png",
  "/favicon-192.png",
  "/apple-touch-icon.png",
];

export const agentSkills: SitePattern = "/.well-known/agent-skills/*";

export const sitePageRoutes = sitePages.filter((pattern) => !sitePages.includes(`${pattern}/*`));

export const matchesSitePattern = (pattern: SitePattern, pathname: string) =>
  pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;

export const isSitePage = (pathname: string) =>
  sitePages.some((pattern) => matchesSitePattern(pattern, pathname));
