import { describe, expect, it } from "@effect/vitest";

import { isMarketingPath } from "./marketing";

// On executor.sh the marketing middleware proxies an allow-list of paths to the
// `executor-marketing` worker; everything else falls through to the auth-gated
// cloud app (the sign-in page). `/blog` and `/llms.txt` are public content, so
// they must be on the allow-list: without it an unauthenticated visit redirects
// to `/login?returnTo=...` and the reader bounces.
describe("isMarketingPath", () => {
  const marketing = [
    "/home",
    "/privacy",
    "/terms",
    "/blog",
    "/blog/",
    "/blog/some-post",
    "/llms.txt",
    "/og-image.png",
    "/_astro/app.css",
    // The blog author card loads its avatar from marketing's public/authors;
    // without this the pfp 404s on every post.
    "/authors/rhys-sullivan.png",
  ];
  for (const pathname of marketing) {
    it(`proxies ${pathname} to marketing`, () => {
      expect(isMarketingPath(pathname)).toBe(true);
    });
  }

  // App-owned routes must reach the Effect handler, not marketing. `/blogger`
  // guards against a bare `startsWith("/blog")` swallowing unrelated words.
  const notMarketing = ["/", "/login", "/cloud", "/mcp", "/dashboard", "/blogger"];
  for (const pathname of notMarketing) {
    it(`leaves ${pathname} alone`, () => {
      expect(isMarketingPath(pathname)).toBe(false);
    });
  }
});
