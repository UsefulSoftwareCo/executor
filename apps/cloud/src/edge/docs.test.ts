import { describe, expect, it } from "@effect/vitest";

import { buildDocsUpstream, isDocsPath } from "./docs";

// The docs proxy claims `/docs` and forwards it to Mintlify. Two things must
// hold: the path matcher catches the docs tree without swallowing the app-owned
// `/api/docs` (Swagger) or unrelated `/docs`-prefixed words, and the rewritten
// upstream request points at Mintlify with the path preserved and the session
// cookie stripped.
describe("isDocsPath", () => {
  const docs = ["/docs", "/docs/", "/docs/quickstart", "/docs/guides/auth"];
  for (const pathname of docs) {
    it(`proxies ${pathname} to Mintlify`, () => {
      expect(isDocsPath(pathname)).toBe(true);
    });
  }

  // `/api/docs` is the app-owned Swagger UI — it must reach the Effect handler,
  // not Mintlify. `/docsmith` guards against a bare `startsWith("/docs")` that
  // would capture unrelated words.
  const notDocs = ["/api/docs", "/docsmith", "/", "/home", "/login", "/mcp"];
  for (const pathname of notDocs) {
    it(`leaves ${pathname} alone`, () => {
      expect(isDocsPath(pathname)).toBe(false);
    });
  }
});

describe("buildDocsUpstream", () => {
  const upstreamFor = (url: string, headers?: HeadersInit) =>
    buildDocsUpstream(new Request(url, { headers }));

  it("swaps the origin to Mintlify over https while preserving path + query", () => {
    const upstream = new URL(upstreamFor("https://executor.sh/docs/guides/auth?theme=dark").url);
    expect(upstream.hostname).toBe("executor.mintlify.dev");
    expect(upstream.protocol).toBe("https:");
    expect(upstream.pathname).toBe("/docs/guides/auth");
    expect(upstream.search).toBe("?theme=dark");
  });

  it("forwards the public host so Mintlify can build canonical links", () => {
    const upstream = upstreamFor("https://executor.sh/docs");
    expect(upstream.headers.get("x-forwarded-host")).toBe("executor.sh");
    expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
  });

  it("strips the cookie so the session never leaks to the docs origin", () => {
    const upstream = upstreamFor("https://executor.sh/docs", {
      cookie: "wos-session=secret",
    });
    expect(upstream.headers.has("cookie")).toBe(false);
  });
});
