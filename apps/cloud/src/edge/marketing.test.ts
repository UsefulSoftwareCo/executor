import { describe, expect, it } from "@effect/vitest";

import {
  isMarketingPath,
  isSignUpPath,
  isV2MarketingPath,
  isV2Path,
  marketingProxyRequest,
  parseV2Edge,
  v2AppOrigin,
  v2EdgeResponse,
  v2PageForSlashedPath,
  v2SignUpUrl,
  type V2EdgeEnv,
  type V2Service,
} from "./marketing";

// On executor.sh only v1's legal pages (terms, privacy policy and Google OAuth
// disclosure) and their asset root still go to v1's `executor-marketing`
// worker; v2 serves the rest of marketing.
describe("isMarketingPath", () => {
  const v1Marketing = [
    "/terms",
    "/terms/",
    "/privacy",
    "/google-oauth",
    "/_v1-marketing/Layout.css",
    "/_v1-marketing/_ph/e",
  ];
  for (const pathname of v1Marketing) {
    it(`sends ${pathname} to v1's marketing worker`, () => {
      expect(isMarketingPath(pathname)).toBe(true);
    });
  }

  const notV1Marketing = [
    "/",
    "/home",
    "/pricing",
    "/blog",
    "/google-workspace",
    "/_astro/app.css",
    "/_astro/_ph/e",
    "/termsandconditions",
    "/privacy-team/mcp",
    "/google-oauthx",
    "/_v1-marketingx",
    "/login",
  ];
  for (const pathname of notV1Marketing) {
    it(`does not send ${pathname} to v1's marketing worker`, () => {
      expect(isMarketingPath(pathname)).toBe(false);
    });
  }
});

describe("marketingProxyRequest", () => {
  it("routes v1's terms, method, headers and body unchanged", async () => {
    const request = new Request("https://executor.sh/_v1-marketing/_ph/capture?ip=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
      body: JSON.stringify({ event: "test" }),
    });

    const proxied = marketingProxyRequest(request);

    expect(proxied?.url).toBe("https://executor.sh/_v1-marketing/_ph/capture?ip=1");
    expect(proxied?.method).toBe("POST");
    expect(proxied?.headers.get("x-request-id")).toBe("request-1");
    await expect(proxied?.json()).resolves.toEqual({ event: "test" });
    for (const path of ["/terms", "/privacy", "/google-oauth"]) {
      expect(marketingProxyRequest(new Request(`https://executor.sh${path}`))?.url).toBe(
        `https://executor.sh${path}`,
      );
    }
  });

  it("leaves the homepage and v2's marketing to the v2 edge", () => {
    expect(marketingProxyRequest(new Request("https://executor.sh/"))).toBeNull();
    expect(marketingProxyRequest(new Request("https://executor.sh/home"))).toBeNull();
    expect(marketingProxyRequest(new Request("https://executor.sh/pricing"))).toBeNull();
  });

  it("does not proxy non-production hosts", () => {
    expect(marketingProxyRequest(new Request("http://executor-cloud.localhost/terms"))).toBeNull();
  });
});

// v2 on executor.sh: sign-up redirects to v2, and a fixed list of paths is
// forwarded to v2's Worker. Everything else stays with v1.
describe("isV2Path", () => {
  const forwarded = [
    "/.well-known/oauth-authorization-server/api/auth",
    "/oauth/client-metadata.json",
    "/api/auth/callback/google",
    "/api/auth/callback/github",
    "/git/acme/tools/info/refs",
    "/git/acme/tools/git-upload-pack",
    "/git/acme/tools/git-receive-pack",
    "/.well-known/agent-skills/",
    "/.well-known/agent-skills/index.json",
  ];
  for (const pathname of forwarded) {
    it(`forwards ${pathname} to v2`, () => {
      expect(isV2Path(pathname)).toBe(true);
    });
  }

  const v1Owned = [
    // v1's WorkOS callback has no provider segment.
    "/api/auth/callback",
    "/api/auth/callback/",
    "/api/auth/callback/google/extra",
    "/api/auth/login",
    "/api/auth/me",
    // v1's own issuer metadata and client metadata document.
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth/extra",
    "/.well-known/oauth-protected-resource/mcp",
    "/oauth/client-id-metadata.json",
    // v2 does not serve OpenID configuration on executor.sh.
    "/api/auth/.well-known/openid-configuration",
    "/oauth/client-metadata.json/extra",
    // Git remotes need a path under /git/.
    "/git",
    "/gitlab/acme/tools/info/refs",
    "/github",
    "/.well-known/agent-skills",
    "/.well-known/agent-skillset/index.json",
    // The connected-account callback goes by its state, not its path, and
    // marketing has its own list.
    "/api/oauth/callback",
    "/pricing",
    // v1 dashboard, org pages and MCP, including org slugs that look similar.
    "/",
    "/login",
    "/mcp",
    "/acme/mcp",
    "/gitops/mcp",
    "/git-team/policies",
    "/oauth-team/mcp",
    "/api/connections",
  ];
  for (const pathname of v1Owned) {
    it(`leaves ${pathname} with v1`, () => {
      expect(isV2Path(pathname)).toBe(false);
    });
  }
});

describe("v2PageForSlashedPath", () => {
  it("canonicalizes only v2's exact pages", () => {
    expect(v2PageForSlashedPath("/pricing/")).toBe("/pricing");
    expect(v2PageForSlashedPath("/google-workspace/")).toBe("/google-workspace");
    expect(v2PageForSlashedPath("/pricing")).toBeNull();
    expect(v2PageForSlashedPath("/pricing.md/")).toBeNull();
    expect(v2PageForSlashedPath("/blog/")).toBeNull();
    expect(v2PageForSlashedPath("/terms/")).toBeNull();
    expect(v2PageForSlashedPath("/")).toBeNull();
  });
});

describe("isSignUpPath", () => {
  it("claims /sign-up and /signup only", () => {
    expect(isSignUpPath("/sign-up")).toBe(true);
    expect(isSignUpPath("/signup")).toBe(true);
    expect(isSignUpPath("/sign-up/")).toBe(false);
    expect(isSignUpPath("/signup/team")).toBe(false);
    expect(isSignUpPath("/sign-in")).toBe(false);
    expect(isSignUpPath("/signups")).toBe(false);
  });
});

describe("parseV2Edge", () => {
  const service: V2Service = { fetch: () => Promise.resolve(new Response(null)) };
  const settings = {
    V2: service,
    V2_SIGN_UP_URL: "https://app.executor.sh/login?mode=signup",
    V2_OAUTH_STATE_PREFIX: "x2.",
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  };

  it("is off when no setting is present", () => {
    expect(parseV2Edge({})).toBeNull();
  });

  it("refuses any setting set without the others", () => {
    expect(typeof parseV2Edge({ ...settings, V2: undefined })).toBe("string");
    expect(typeof parseV2Edge({ ...settings, V2_SIGN_UP_URL: undefined })).toBe("string");
    expect(typeof parseV2Edge({ ...settings, V2_OAUTH_STATE_PREFIX: undefined })).toBe("string");
    expect(typeof parseV2Edge({ ...settings, V2_ANALYTICS_PROXY_PATH: undefined })).toBe("string");
    expect(typeof parseV2Edge({ ...settings, V2_ERROR_TUNNEL_PATH: undefined })).toBe("string");
    expect(typeof parseV2Edge({ V2_OAUTH_STATE_PREFIX: "x2." })).toBe("string");
  });

  it("refuses a sign-up URL that is not absolute http(s)", () => {
    expect(typeof parseV2Edge({ ...settings, V2_SIGN_UP_URL: "/login?mode=signup" })).toBe(
      "string",
    );
    expect(typeof parseV2Edge({ ...settings, V2_SIGN_UP_URL: "javascript:alert(1)" })).toBe(
      "string",
    );
  });

  // v1's states are base64url (raw, or the org-wrapped JSON encoding), so a
  // prefix made only of base64url characters could claim a v1 callback.
  it("refuses a state prefix that a v1 state could start with", () => {
    for (const prefix of ["", "x2", "x2-", "x2_", "eyJ", "x2 .", "x2.%", "x2./"]) {
      expect(typeof parseV2Edge({ ...settings, V2_OAUTH_STATE_PREFIX: prefix })).toBe("string");
    }
  });

  it("refuses an analytics proxy path other than /api/<16 lowercase hex>", () => {
    for (const path of [
      "",
      "/api/0123456789abcde",
      "/api/0123456789abcdef0",
      "/api/0123456789ABCDEF",
      "/api/0123456789abcdef/",
      "/api/0123456789abcdef/submit",
      "/api/connections",
      "/0123456789abcdef",
      " /api/0123456789abcdef",
      "/api/0123456789abcdef,/api/fedcba9876543210",
    ]) {
      expect(typeof parseV2Edge({ ...settings, V2_ANALYTICS_PROXY_PATH: path })).toBe("string");
    }
  });

  it("refuses an error tunnel path other than /api/<16 lowercase hex>/submit", () => {
    for (const path of [
      "",
      "/api/fedcba9876543210",
      "/api/fedcba9876543210/",
      "/api/fedcba9876543210/submit/",
      "/api/fedcba9876543210/submitx",
      "/api/FEDCBA9876543210/submit",
      "/api/fedcba987654321/submit",
      "/api/fedcba9876543210/e",
      "/fedcba9876543210/submit",
      " /api/fedcba9876543210/submit",
    ]) {
      expect(typeof parseV2Edge({ ...settings, V2_ERROR_TUNNEL_PATH: path })).toBe("string");
    }
  });

  it("parses all settings", () => {
    const edge = parseV2Edge(settings);
    if (edge === null || typeof edge === "string") return expect.unreachable("settings must parse");
    expect(edge.signUpUrl.href).toBe("https://app.executor.sh/login?mode=signup");
    expect(edge.oauthStatePrefix).toBe("x2.");
    expect(edge.analyticsProxyPath).toBe("/api/0123456789abcdef");
    expect(edge.errorTunnelPath).toBe("/api/fedcba9876543210/submit");
    expect(typeof parseV2Edge({ ...settings, V2_OAUTH_STATE_PREFIX: "v2~" })).toBe("object");
  });
});

// Where v1 sends anything that would create an organization: v2's sign-up page
// (and its origin, v2's app host).
describe("v2SignUpUrl", () => {
  const service: V2Service = { fetch: () => Promise.resolve(new Response(null)) };
  const settings = {
    V2: service,
    V2_SIGN_UP_URL: "https://app.executor.sh/login?mode=signup",
    V2_OAUTH_STATE_PREFIX: "x2.",
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  };

  it("is v2's sign-up page, query kept, and v2AppOrigin is its origin", () => {
    expect(v2SignUpUrl(settings)?.href).toBe("https://app.executor.sh/login?mode=signup");
    expect(v2AppOrigin(settings)?.href).toBe("https://app.executor.sh/");
  });

  it("is null where v1 has no v2: no settings, or broken ones", () => {
    expect(v2SignUpUrl({})).toBeNull();
    expect(v2SignUpUrl({ ...settings, V2: undefined })).toBeNull();
    expect(v2SignUpUrl({ ...settings, V2_SIGN_UP_URL: "/login?mode=signup" })).toBeNull();
    expect(v2AppOrigin({})).toBeNull();
  });
});

describe("v2EdgeResponse", () => {
  const SIGN_UP_URL = "https://v2.executor.sh/login?mode=signup";
  const STATE_PREFIX = "x2.";

  /** The edge's settings with `service` as v2's Worker. */
  const settings = (service: V2Service, signUpUrl = SIGN_UP_URL): V2EdgeEnv => ({
    V2: service,
    V2_SIGN_UP_URL: signUpUrl,
    V2_OAUTH_STATE_PREFIX: STATE_PREFIX,
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  });

  /** A v2 service that records what it receives and answers with `respond`. */
  const recordingService = (respond: (request: Request) => Promise<Response> | Response) => {
    const received: Request[] = [];
    const service: V2Service = {
      fetch: async (request) => {
        received.push(request);
        return respond(request);
      },
    };
    return { received, service };
  };

  it("redirects sign-up to v2's configured sign-up page, ignoring the query", async () => {
    const { received, service } = recordingService(() => new Response(null));

    for (const url of ["https://executor.sh/sign-up", "https://executor.sh/signup?ref=docs"]) {
      const response = await v2EdgeResponse(new Request(url), settings(service));
      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe(SIGN_UP_URL);
    }
    expect(received).toHaveLength(0);
  });

  it("follows the configured sign-up URL", async () => {
    const response = await v2EdgeResponse(
      new Request("https://executor.sh/signup"),
      settings(
        { fetch: () => Promise.resolve(new Response(null)) },
        "https://app.executor.sh/sign-up",
      ),
    );
    expect(response?.headers.get("location")).toBe("https://app.executor.sh/sign-up");
  });

  it("leaves non-GET sign-up requests with v1", () => {
    const { service } = recordingService(() => new Response(null));
    expect(
      v2EdgeResponse(
        new Request("https://executor.sh/sign-up", { method: "POST" }),
        settings(service),
      ),
    ).toBeNull();
  });

  it("answers edge requests with a 500 on a broken setting and leaves other paths with v1", async () => {
    const { received, service } = recordingService(() => new Response(null));
    const response = await v2EdgeResponse(
      new Request("https://executor.sh/sign-up"),
      settings(service, "/relative"),
    );
    expect(response?.status).toBe(500);
    expect(
      v2EdgeResponse(new Request("https://executor.sh/acme/mcp"), settings(service, "/relative")),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("is off without settings", () => {
    expect(v2EdgeResponse(new Request("https://executor.sh/sign-up"), {})).toBeNull();
  });

  it("only acts on executor.sh", () => {
    const { service } = recordingService(() => new Response(null));
    expect(
      v2EdgeResponse(new Request("http://executor-cloud.localhost/sign-up"), settings(service)),
    ).toBeNull();
    expect(
      v2EdgeResponse(
        new Request("https://v2.executor.sh/api/auth/callback/google"),
        settings(service),
      ),
    ).toBeNull();
  });

  it("leaves v1 paths with v1", () => {
    const { received, service } = recordingService(() => new Response(null));
    expect(
      v2EdgeResponse(
        new Request("https://executor.sh/api/auth/callback?code=c"),
        settings(service),
      ),
    ).toBeNull();
    expect(
      v2EdgeResponse(new Request("https://executor.sh/gitlab/x/info/refs"), settings(service)),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("forwards with the public host, path and query, and returns v2's redirect unfollowed", async () => {
    const { received, service } = recordingService(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://app.executor.sh/api/auth/callback/google?code=c&state=s" },
        }),
    );

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/api/auth/callback/google?code=c&state=s"),
      settings(service),
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://app.executor.sh/api/auth/callback/google?code=c&state=s",
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("https://executor.sh/api/auth/callback/google?code=c&state=s");
    expect(received[0]?.redirect).toBe("manual");
  });

  it("strips v1's cookies and client forwarding headers but keeps Authorization", async () => {
    const { received, service } = recordingService(() => new Response("ok"));

    await v2EdgeResponse(
      new Request("https://executor.sh/git/acme/tools/info/refs?service=git-upload-pack", {
        headers: {
          authorization: "Basic dXNlcjp0b2tlbg==",
          cookie: "wos-session=sealed; ph_id=1",
          "git-protocol": "version=2",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
      }),
      settings(service),
    );

    const forwarded = received[0];
    expect(forwarded?.headers.get("authorization")).toBe("Basic dXNlcjp0b2tlbg==");
    expect(forwarded?.headers.get("git-protocol")).toBe("version=2");
    expect(forwarded?.headers.has("cookie")).toBe(false);
    expect(forwarded?.headers.has("x-forwarded-host")).toBe(false);
    expect(forwarded?.headers.has("x-forwarded-proto")).toBe(false);
    expect(new URL(forwarded?.url ?? "").search).toBe("?service=git-upload-pack");
  });

  it("returns v2's response unchanged, status and body stream included", async () => {
    const upstream = new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain", "www-authenticate": 'Basic realm="git"' },
    });
    const { service } = recordingService(() => upstream);

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/git/acme/tools/info/refs"),
      settings(service),
    );

    expect(response).toBe(upstream);
  });

  it("streams a git push body to v2 without buffering it, preserving the method", async () => {
    const encoder = new TextEncoder();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(encoder.encode("first-pack-chunk"));
      },
    });
    // v2 reads the first chunk while the client is still sending: a buffering
    // edge would wait for the end of the body and never reach v2.
    const { received, service } = recordingService(async (request) => {
      const reader = request.body?.getReader();
      if (reader === undefined) return new Response("no body", { status: 500 });
      const first = await reader.read();
      source?.enqueue(encoder.encode("second-pack-chunk"));
      source?.close();
      const second = await reader.read();
      const done = await reader.read();
      const decoder = new TextDecoder();
      return new Response(
        `${decoder.decode(first.value)}|${decoder.decode(second.value)}|${done.done}`,
      );
    });

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/git/acme/tools/git-receive-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body,
        // @ts-expect-error -- Node's fetch needs `duplex` for a stream body; workerd does not.
        duplex: "half",
      }),
      settings(service),
    );

    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.headers.get("content-type")).toBe("application/x-git-receive-pack-request");
    expect(await response?.text()).toBe("first-pack-chunk|second-pack-chunk|true");
  });
});

// v1 and v2 share `/api/oauth/callback` on executor.sh. v2 starts its state
// with a fixed prefix; the edge reads only the query's `state` to decide.
describe("v2EdgeResponse connected-account callback", () => {
  const settings = (service: V2Service): V2EdgeEnv => ({
    V2: service,
    V2_SIGN_UP_URL: "https://app.executor.sh/login?mode=signup",
    V2_OAUTH_STATE_PREFIX: "x2.",
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  });

  const recordingService = () => {
    const received: Request[] = [];
    const service: V2Service = {
      fetch: async (request) => {
        received.push(request);
        return new Response(null, {
          status: 302,
          headers: { location: `https://app.executor.sh${new URL(request.url).search}` },
        });
      },
    };
    return { received, service };
  };

  it("forwards a callback whose state carries v2's prefix, query unchanged", async () => {
    const { received, service } = recordingService();
    const callback = "https://executor.sh/api/oauth/callback?code=c&state=x2.abc123";

    const response = await v2EdgeResponse(
      new Request(callback, { headers: { cookie: "wos-session=sealed" } }),
      settings(service),
    );

    expect(response?.status).toBe(302);
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe(callback);
    expect(received[0]?.redirect).toBe("manual");
    expect(received[0]?.headers.has("cookie")).toBe(false);
  });

  it("reads a percent-encoded prefix as the prefix", async () => {
    const { received, service } = recordingService();

    await v2EdgeResponse(
      new Request("https://executor.sh/api/oauth/callback?state=x2%2Eabc&code=c"),
      settings(service),
    );

    expect(received).toHaveLength(1);
  });

  it("forwards v2's provider errors, which carry the state but no code", async () => {
    const { received, service } = recordingService();

    await v2EdgeResponse(
      new Request("https://executor.sh/api/oauth/callback?error=access_denied&state=x2.abc"),
      settings(service),
    );

    expect(received).toHaveLength(1);
  });

  const v1Callbacks = [
    // v1's raw state and its org-wrapped base64url JSON state.
    "https://executor.sh/api/oauth/callback?code=c&state=Q2xpZW50U3RhdGUxMjM0NTY3ODkw",
    "https://executor.sh/api/oauth/callback?code=c&state=eyJzdGF0ZSI6InMiLCJvcmdTbHVnIjoiYWNtZSJ9",
    // No state, or an empty one.
    "https://executor.sh/api/oauth/callback?code=c",
    "https://executor.sh/api/oauth/callback?code=c&state=",
    "https://executor.sh/api/oauth/callback",
    // Lookalikes: the prefix without its dot, another case, inside the
    // value, or in another parameter.
    "https://executor.sh/api/oauth/callback?code=c&state=x2abc",
    "https://executor.sh/api/oauth/callback?code=c&state=x2-abc",
    "https://executor.sh/api/oauth/callback?code=c&state=X2.abc",
    "https://executor.sh/api/oauth/callback?code=c&state=ax2.abc",
    "https://executor.sh/api/oauth/callback?code=c&state=%20x2.abc",
    "https://executor.sh/api/oauth/callback?code=x2.abc&state=v1state",
    "https://executor.sh/api/oauth/callback?code=c&xstate=x2.abc",
    // Only the first state counts.
    "https://executor.sh/api/oauth/callback?state=v1state&state=x2.abc",
    // Other paths with a v2 state.
    "https://executor.sh/api/oauth/callback/?state=x2.abc",
    "https://executor.sh/api/oauth/callbacks?state=x2.abc",
    "https://executor.sh/api/oauth/callback/extra?state=x2.abc",
    "https://executor.sh/acme/api/oauth/callback?state=x2.abc",
  ];
  for (const url of v1Callbacks) {
    it(`leaves ${new URL(url).pathname}${new URL(url).search} with v1`, () => {
      const { received, service } = recordingService();
      expect(v2EdgeResponse(new Request(url), settings(service))).toBeNull();
      expect(received).toHaveLength(0);
    });
  }

  it("decides from the query without reading a posted body", () => {
    const { received, service } = recordingService();
    const body = new ReadableStream<Uint8Array>({
      pull: () => expect.unreachable("the edge must not read the body"),
    });

    expect(
      v2EdgeResponse(
        new Request("https://executor.sh/api/oauth/callback", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          // @ts-expect-error -- Node's fetch needs `duplex` for a stream body; workerd does not.
          duplex: "half",
        }),
        settings(service),
      ),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("only acts on executor.sh", () => {
    const { received, service } = recordingService();
    expect(
      v2EdgeResponse(
        new Request("https://v2.executor.sh/api/oauth/callback?state=x2.abc"),
        settings(service),
      ),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("leaves every callback with v1 when the settings are absent or broken", () => {
    const { received, service } = recordingService();
    const request = () => new Request("https://executor.sh/api/oauth/callback?state=x2.abc");

    expect(v2EdgeResponse(request(), {})).toBeNull();
    expect(v2EdgeResponse(request(), { ...settings(service), V2_SIGN_UP_URL: "/x" })).toBeNull();
    expect(
      v2EdgeResponse(request(), { ...settings(service), V2_OAUTH_STATE_PREFIX: "x2" }),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });
});

// v2's marketing site answers executor.sh: the landing page without a v1
// session, its pages, files, assets and docs, and its telemetry proxies. A
// pattern is exact, or `/x/*` for everything that starts with `/x/`.
describe("isV2MarketingPath", () => {
  const v2Marketing = [
    "/home",
    "/about-executor",
    "/blog",
    "/blog/",
    "/blog/some-post",
    "/pricing",
    "/google-workspace",
    "/index.md",
    "/llms.txt",
    "/pricing.md",
    "/setup-prompt.md",
    "/_astro/app.Cld-QA3g.css",
    "/authors/author.png",
    "/og-image.png",
    "/pattern-graph-paper.svg",
    "/docs",
    "/docs/",
    "/docs/quickstart",
    "/docs/llms.txt",
    // `apps` and `experiments` are reserved v1 organization slugs.
    "/apps",
    "/apps/",
    "/apps/detail",
    "/experiments/",
    "/experiments/hero/b",
  ];
  for (const pathname of v2Marketing) {
    it(`sends ${pathname} to v2`, () => {
      expect(isV2MarketingPath(pathname)).toBe(true);
    });
  }

  const v1Owned = [
    // The homepage depends on the session; see v2EdgeResponse.
    "/",
    // `/demo` is an unreserved v1 organization slug; v2 publishes nothing at
    // a bare `/experiments`.
    "/demo",
    "/demo/workflows",
    "/experiments",
    // Exact pages match only themselves, and directories only what is below
    // them.
    "/pricing/extra",
    "/home/extra",
    "/home/",
    "/llms.txt/x",
    "/_astro",
    "/authors",
    "/google-workspace/x",
    // v1's legal pages, and its dashboard's favicons.
    "/terms",
    "/privacy",
    "/google-oauth",
    "/favicon.ico",
    "/favicon-32.png",
    "/apple-touch-icon.png",
    // Lookalikes and v1 routes.
    "/blogger",
    "/appsmith",
    "/experimentsx/a",
    "/docsearch",
    "/_astrox/app.css",
    "/home-team/policies",
    "/pricing-team/mcp",
    "/setup",
    "/login",
    "/api/docs",
    "/acme/docs",
  ];
  for (const pathname of v1Owned) {
    it(`leaves ${pathname} with v1`, () => {
      expect(isV2MarketingPath(pathname)).toBe(false);
    });
  }
});

describe("v2EdgeResponse marketing", () => {
  const settings = (service: V2Service): V2EdgeEnv => ({
    V2: service,
    V2_SIGN_UP_URL: "https://app.executor.sh/login?mode=signup",
    V2_OAUTH_STATE_PREFIX: "x2.",
    V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
    V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
  });

  const recordingService = (respond: () => Response = () => new Response("v2")) => {
    const received: Request[] = [];
    const service: V2Service = {
      fetch: async (request) => {
        received.push(request);
        return respond();
      },
    };
    return { received, service };
  };

  // A signed-out visitor at `/pricing/` would otherwise reach v1's sign-in
  // gate, which redirects to login.
  it("redirects v2's slashed exact pages to the page, query kept, without forwarding", async () => {
    const { received, service } = recordingService();

    for (const [target, location] of [
      ["/pricing/", "/pricing"],
      ["/pricing/?ref=hn", "/pricing?ref=hn"],
      ["/home/", "/home"],
      ["/about-executor/", "/about-executor"],
      ["/google-workspace/", "/google-workspace"],
    ] as const) {
      for (const method of ["GET", "HEAD"]) {
        const response = await v2EdgeResponse(
          new Request(`https://executor.sh${target}`, {
            method,
            headers: { cookie: "wos-session=sealed" },
          }),
          settings(service),
        );
        expect(response?.status, `${method} ${target}`).toBe(308);
        expect(response?.headers.get("location"), `${method} ${target}`).toBe(
          `https://executor.sh${location}`,
        );
      }
    }
    expect(received).toHaveLength(0);
  });

  it("forwards the slashed form of a page v2 owns below, such as /blog/", async () => {
    const { received, service } = recordingService();

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/docs/"),
      settings(service),
    );

    expect(await response?.text()).toBe("v2");
    expect(received[0]?.url).toBe("https://executor.sh/docs/");
  });

  it("keeps deeper paths, other methods and v1's own slashed pages with v1", () => {
    const { received, service } = recordingService();

    for (const [method, target] of [
      ["GET", "/pricing/extra"],
      ["GET", "/home/extra/"],
      ["GET", "/pricing//"],
      ["POST", "/pricing/"],
      ["GET", "/terms/"],
      ["GET", "/demo/"],
    ] as const) {
      expect(
        v2EdgeResponse(new Request(`https://executor.sh${target}`, { method }), settings(service)),
        `${method} ${target}`,
      ).toBeNull();
    }
    expect(received).toHaveLength(0);
  });

  it("redirects v2 dashboard links to v2's app host, path and query kept", async () => {
    const { received, service } = recordingService();

    for (const target of ["/org/acme/apps/app_1/open", "/org/acme?tab=kpis", "/org/acme/"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await v2EdgeResponse(
          new Request(`https://executor.sh${target}`, {
            method,
            headers: { cookie: "wos-session=sealed" },
          }),
          settings(service),
        );
        expect(response?.status, `${method} ${target}`).toBe(308);
        expect(response?.headers.get("location"), `${method} ${target}`).toBe(
          `https://app.executor.sh${target}`,
        );
      }
    }
    expect(received).toHaveLength(0);
  });

  it("keeps v1's own /org page and non-navigation methods with v1", () => {
    const { received, service } = recordingService();

    for (const [method, target] of [
      ["GET", "/org"],
      ["GET", "/acme/org"],
      ["GET", "/organization/x"],
      ["POST", "/org/acme"],
    ] as const) {
      expect(
        v2EdgeResponse(new Request(`https://executor.sh${target}`, { method }), settings(service)),
        `${method} ${target}`,
      ).toBeNull();
    }
    expect(received).toHaveLength(0);
  });

  it("sends the signed-out homepage to v2 with the URL unchanged", async () => {
    const { received, service } = recordingService();

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/?hero=b&utm_source=x"),
      settings(service),
    );

    expect(await response?.text()).toBe("v2");
    expect(received[0]?.url).toBe("https://executor.sh/?hero=b&utm_source=x");
    expect(received[0]?.redirect).toBe("manual");
  });

  it("keeps the signed-in homepage with v1's dashboard", () => {
    const { received, service } = recordingService();

    expect(
      v2EdgeResponse(
        new Request("https://executor.sh/", {
          headers: { cookie: "executor_visitor=v; wos-session=sealed" },
        }),
        settings(service),
      ),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("passes only v2's visitor cookie, never v1's session", async () => {
    const { received, service } = recordingService();

    await v2EdgeResponse(
      new Request("https://executor.sh/blog/post", {
        headers: {
          cookie:
            "ph_id=1; executor_visitor=0f1e2d3c-4b5a-4987-a6b5-c4d3e2f1a0b9; wos-session=sealed",
          "x-forwarded-host": "attacker.example",
        },
      }),
      settings(service),
    );
    await v2EdgeResponse(
      new Request("https://executor.sh/", { headers: { cookie: "ph_id=1; executor_hero=x" } }),
      settings(service),
    );

    expect(received[0]?.headers.get("cookie")).toBe(
      "executor_visitor=0f1e2d3c-4b5a-4987-a6b5-c4d3e2f1a0b9",
    );
    expect(received[0]?.headers.has("x-forwarded-host")).toBe(false);
    expect(received[1]?.headers.has("cookie")).toBe(false);
  });

  it("serves /home, docs and assets from v2 without rewriting the path", async () => {
    const { received, service } = recordingService();

    for (const url of [
      "https://executor.sh/home?ref=x",
      "https://executor.sh/docs/quickstart",
      "https://executor.sh/_astro/app.css",
      "https://executor.sh/llms.txt",
    ]) {
      await v2EdgeResponse(new Request(url), settings(service));
    }

    expect(received.map((request) => request.url)).toEqual([
      "https://executor.sh/home?ref=x",
      "https://executor.sh/docs/quickstart",
      "https://executor.sh/_astro/app.css",
      "https://executor.sh/llms.txt",
    ]);
  });

  it("returns v2's response unchanged, its cookies included", async () => {
    const upstream = new Response("<html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "set-cookie": "executor_visitor=v; Path=/; SameSite=Lax; Secure",
        vary: "Cookie",
      },
    });
    const { service } = recordingService(() => upstream);

    expect(await v2EdgeResponse(new Request("https://executor.sh/"), settings(service))).toBe(
      upstream,
    );
  });

  it("answers marketing with a 500 on broken settings", async () => {
    const { received, service } = recordingService();

    const brokenAnalytics = await v2EdgeResponse(new Request("https://executor.sh/pricing"), {
      ...settings(service),
      V2_ANALYTICS_PROXY_PATH: "/api/nothex",
    });
    const brokenTunnel = await v2EdgeResponse(new Request("https://executor.sh/pricing"), {
      ...settings(service),
      V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210",
    });

    expect(brokenAnalytics?.status).toBe(500);
    expect(brokenTunnel?.status).toBe(500);
    expect(received).toHaveLength(0);
  });

  it("is off without settings and off executor.sh", () => {
    const { received, service } = recordingService();

    expect(v2EdgeResponse(new Request("https://executor.sh/"), {})).toBeNull();
    expect(v2EdgeResponse(new Request("https://executor.sh/pricing"), {})).toBeNull();
    expect(
      v2EdgeResponse(new Request("http://executor-cloud.localhost/"), settings(service)),
    ).toBeNull();
    expect(
      v2EdgeResponse(new Request("http://executor-cloud.localhost/docs"), settings(service)),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("forwards v2's telemetry proxies without cookies, body and method intact", async () => {
    const { received, service } = recordingService();

    await v2EdgeResponse(
      new Request("https://executor.sh/api/0123456789abcdef/e/?ip=1", {
        method: "POST",
        headers: { cookie: "wos-session=sealed", "content-type": "text/plain" },
        body: "event",
      }),
      settings(service),
    );
    await v2EdgeResponse(
      new Request("https://executor.sh/api/fedcba9876543210/submit", { method: "POST" }),
      settings(service),
    );
    expect(received.map((request) => request.url)).toEqual([
      "https://executor.sh/api/0123456789abcdef/e/?ip=1",
      "https://executor.sh/api/fedcba9876543210/submit",
    ]);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.headers.has("cookie")).toBe(false);
    expect(await received[0]?.text()).toBe("event");
  });

  const v1Api = [
    // Another 16-hex root, and v1's own PostHog proxy (8 hex).
    "https://executor.sh/api/aaaaaaaaaaaaaaaa/e/",
    "https://executor.sh/api/aaaaaaaaaaaaaaaa/submit",
    // The analytics proxy is forwarded below its root, not the root itself.
    "https://executor.sh/api/0123456789abcdef",
    // The error tunnel is forwarded exactly: not its root or other subpaths.
    "https://executor.sh/api/fedcba9876543210",
    "https://executor.sh/api/fedcba9876543210/",
    "https://executor.sh/api/fedcba9876543210/e/",
    "https://executor.sh/api/fedcba9876543210/submit/",
    "https://executor.sh/api/fedcba9876543210/submit/x",
    "https://executor.sh/api/0a1b2c3d/e/",
    // Lookalikes of a configured root.
    "https://executor.sh/api/0123456789abcdef0/e/",
    "https://executor.sh/api/0123456789abcdefx",
    "https://executor.sh/0123456789abcdef/e/",
    "https://executor.sh/acme/api/0123456789abcdef/e/",
    // v1's API.
    "https://executor.sh/api/connections",
    "https://executor.sh/api/docs",
  ];
  for (const url of v1Api) {
    it(`leaves ${new URL(url).pathname} with v1`, () => {
      const { received, service } = recordingService();
      expect(v2EdgeResponse(new Request(url), settings(service))).toBeNull();
      expect(received).toHaveLength(0);
    });
  }

  it("leaves telemetry roots with v1 when the settings are broken", () => {
    const { received, service } = recordingService();

    expect(
      v2EdgeResponse(new Request("https://executor.sh/api/0123456789abcdef/e/"), {
        ...settings(service),
        V2_SIGN_UP_URL: "/relative",
      }),
    ).toBeNull();
    expect(received).toHaveLength(0);
  });
});
