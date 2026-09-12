import { describe, expect, it } from "@effect/vitest";

import { isMarketingPath, marketingProxyRequest } from "./marketing";

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
    "/pricing",
    "/about-executor",
    "/google-oauth",
    "/google-workspace",
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

describe("marketingProxyRequest", () => {
  it("routes a signed-out homepage request", () => {
    const request = new Request("https://executor.sh/?source=test");

    const proxied = marketingProxyRequest(request);

    expect(proxied?.url).toBe("https://executor.sh/?source=test");
  });

  it("leaves the signed-in homepage with the cloud application", () => {
    const request = new Request("https://executor.sh/", {
      headers: { cookie: "other=value; wos-session=sealed" },
    });

    expect(marketingProxyRequest(request)).toBeNull();
  });

  it("routes public content even when a session cookie is present", () => {
    const request = new Request("https://executor.sh/blog/post", {
      headers: { cookie: "wos-session=sealed" },
    });

    expect(marketingProxyRequest(request)?.url).toBe("https://executor.sh/blog/post");
  });

  it("routes /pricing to the marketing worker", () => {
    const request = new Request("https://executor.sh/pricing");

    expect(marketingProxyRequest(request)?.url).toBe("https://executor.sh/pricing");
  });

  it("rewrites the public home alias to the marketing root", () => {
    const request = new Request("https://executor.sh/home?source=test");

    expect(marketingProxyRequest(request)?.url).toBe("https://executor.sh/?source=test");
  });

  it("preserves the request method, headers, and body", async () => {
    const request = new Request("https://executor.sh/_astro/_ph/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
      body: JSON.stringify({ event: "test" }),
    });

    const proxied = marketingProxyRequest(request);

    expect(proxied?.method).toBe("POST");
    expect(proxied?.headers.get("x-request-id")).toBe("request-1");
    await expect(proxied?.json()).resolves.toEqual({ event: "test" });
  });

  it("does not proxy non-production hosts or app-owned paths", () => {
    expect(marketingProxyRequest(new Request("http://executor-cloud.localhost/"))).toBeNull();
    expect(marketingProxyRequest(new Request("https://executor.sh/login"))).toBeNull();
  });
});
