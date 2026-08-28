import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";

import {
  buildDocsUpstream,
  buildPosthogUpstream,
  isDocsPath,
  isPosthogPath,
  passthroughResponse,
  POSTHOG_PROXY_PATH,
} from "./passthrough";

describe("passthrough matching", () => {
  it("claims /docs and everything under it, but not /api/docs", () => {
    expect(isDocsPath("/docs")).toBe(true);
    expect(isDocsPath("/docs/concepts/policies")).toBe(true);
    // The app-owned Swagger route must keep reaching the Effect app.
    expect(isDocsPath("/api/docs")).toBe(false);
    expect(isDocsPath("/docsearch")).toBe(false);
  });

  it("claims the PostHog proxy path and its subtree only", () => {
    expect(isPosthogPath(POSTHOG_PROXY_PATH)).toBe(true);
    expect(isPosthogPath(`${POSTHOG_PROXY_PATH}/i/v0/e/`)).toBe(true);
    expect(isPosthogPath(`${POSTHOG_PROXY_PATH}extra`)).toBe(false);
    expect(isPosthogPath("/api/connections")).toBe(false);
  });

  it("returns null for app paths so they fall through to normal dispatch", () => {
    expect(passthroughResponse(new Request("https://executor.sh/"), "/")).toBeNull();
    expect(
      passthroughResponse(new Request("https://executor.sh/api/connections"), "/api/connections"),
    ).toBeNull();
    expect(passthroughResponse(new Request("https://executor.sh/mcp"), "/mcp")).toBeNull();
  });
});

describe("upstream construction", () => {
  it("forwards the docs path unchanged and strips the session cookie", () => {
    const upstream = buildDocsUpstream(
      new Request("https://executor.sh/docs/concepts/policies?x=1", {
        headers: { cookie: "wos-session=secret" },
      }),
    );
    const url = new URL(upstream.url);
    expect(url.hostname).toBe("executor.mintlify.dev");
    expect(url.pathname).toBe("/docs/concepts/policies");
    expect(url.search).toBe("?x=1");
    expect(upstream.headers.get("X-Forwarded-Host")).toBe("executor.sh");
    expect(upstream.headers.get("cookie")).toBeNull();
  });

  it("strips the proxy prefix for PostHog and splits ingest from assets", () => {
    const ingest = buildPosthogUpstream(
      new Request(`https://executor.sh${POSTHOG_PROXY_PATH}/i/v0/e/`),
      `${POSTHOG_PROXY_PATH}/i/v0/e/`,
    );
    expect(new URL(ingest.url).hostname).toBe("us.i.posthog.com");
    expect(new URL(ingest.url).pathname).toBe("/i/v0/e/");

    const assets = buildPosthogUpstream(
      new Request(`https://executor.sh${POSTHOG_PROXY_PATH}/static/array.js`),
      `${POSTHOG_PROXY_PATH}/static/array.js`,
    );
    expect(new URL(assets.url).hostname).toBe("us-assets.i.posthog.com");
    expect(new URL(assets.url).pathname).toBe("/static/array.js");
  });
});

describe("Start-graph independence", () => {
  // The entire point of this module is that server.ts can answer a proxy
  // request WITHOUT importing TanStack Start. An import of the app or of
  // `@tanstack/react-start` here silently reintroduces the ~3.1s cold-isolate
  // `loadEntries` cost this module exists to avoid, and nothing else would
  // catch it — the behavior stays correct, only slow.
  it("imports neither TanStack Start nor an app module", () => {
    const source = readFileSync(new URL("./passthrough.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/@tanstack/);
      expect(specifier).not.toMatch(/^\.\.\//);
    }
  });
});
