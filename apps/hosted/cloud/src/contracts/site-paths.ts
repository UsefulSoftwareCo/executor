/**
 * The public site (marketing and docs) lives on the edge, `executor.sh`
 * (`notes/cloud-domains.md`). Its pages run through the Worker on every host, so the deployment
 * and browser origins can send them there; their static files are served from any host.
 */

/** A path pattern in the form both the router and `run_worker_first` read: exact, or `/*`. */
export type SitePattern = `/${string}`;

/** Site pages: HTML documents and their Markdown and text forms, served by the edge. */
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
  // Experiments and demos. `/demo` is a v1 organization, so demos live under `/experiments/demo`.
  "/experiments/*",
];

/**
 * Site pages v1 keeps on `executor.sh`: its Google OAuth verification names its own Google
 * page, privacy policy and terms there. The deployment and browser origins still send these
 * paths to `executor.sh`, where v1 answers them.
 */
export const v1SitePages: ReadonlyArray<SitePattern> = ["/google-oauth", "/privacy", "/terms"];

/** Static files the site's pages load, which every host serves from its assets. */
export const siteFiles: ReadonlyArray<SitePattern> = [
  "/_astro/*",
  "/authors/*",
  "/favicon-32.png",
  "/favicon-192.png",
  "/apple-touch-icon.png",
  "/og-image.png",
  "/pattern-graph-paper.svg",
];

/**
 * Site files v1 keeps on `executor.sh`: its dashboard serves byte-identical favicons there. The
 * deployment and browser origins serve them from their own assets.
 */
export const v1SiteFiles: ReadonlyArray<SitePattern> = [
  "/favicon-32.png",
  "/favicon-192.png",
  "/apple-touch-icon.png",
];

/**
 * The agent skills index and its files, published beside the docs. Unlike site pages, every host
 * that serves the product keeps answering them: installed apps store the URL they read skills
 * from (the Executor app names its installation's API origin), and app reads do not follow
 * redirects.
 */
export const agentSkills: SitePattern = "/.well-known/agent-skills/*";

/**
 * Site page routes for the router, whose `/x/*` also matches `/x`: each exact pattern a
 * wildcard covers is left out.
 */
export const sitePageRoutes = sitePages.filter((pattern) => !sitePages.includes(`${pattern}/*`));

/** Whether `pathname` matches `pattern`. */
export const matchesSitePattern = (pattern: SitePattern, pathname: string) =>
  pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;

/** Whether `pathname` is a site page, which only the edge serves. */
export const isSitePage = (pathname: string) =>
  sitePages.some((pattern) => matchesSitePattern(pattern, pathname));
