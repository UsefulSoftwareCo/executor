import { describe, expect, it } from "@effect/vitest";

import { browserTracesResponse } from "./browser-traces";

const makeRequest = (init?: RequestInit & { path?: string }) =>
  new Request(`https://executor.sh${init?.path ?? "/v1/traces"}`, {
    method: "POST",
    body: "{}",
    ...init,
  });

const baseEnv = {
  AXIOM_TOKEN: "axiom-secret",
  AXIOM_DATASET: "executor-cloud",
} as Env;

describe("browserTracesResponse", () => {
  it("ignores non-/v1/traces requests entirely", () => {
    expect(browserTracesResponse(makeRequest({ path: "/api/tools" }), baseEnv)).toBeNull();
  });

  it("drops batches silently when Axiom is not configured", async () => {
    const response = await browserTracesResponse(
      makeRequest({ headers: { cookie: "wos-session=abc" } }),
      {} as Env,
    );
    expect(response?.status).toBe(204);
  });

  it("rejects anonymous posts", async () => {
    const response = await browserTracesResponse(makeRequest(), baseEnv);
    expect(response?.status).toBe(401);
  });

  it("forwards to Axiom with server-held credentials and hides the upstream body", async () => {
    let seen: { url: string; auth: string | null; dataset: string | null } | undefined;
    const response = await browserTracesResponse(
      makeRequest({ headers: { cookie: "wos-session=abc" } }),
      baseEnv,
      (async (url: RequestInfo | URL, init?: RequestInit) => {
        seen = {
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          dataset: new Headers(init?.headers).get("x-axiom-dataset"),
        };
        return new Response("axiom-internals", { status: 200 });
      }) as typeof fetch,
    );
    expect(seen?.url).toBe("https://api.axiom.co/v1/traces");
    expect(seen?.auth).toBe("Bearer axiom-secret");
    expect(seen?.dataset).toBe("executor-cloud");
    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
  });

  it("scrubs credential-bearing URLs from the forwarded payload", async () => {
    // The browser's OTLP batch is pre-serialized JSON; the worker must scrub
    // the decoded payload before forwarding — the page-side exporter is not a
    // trust boundary.
    const SECRET = "synthetic-browser-forward-canary";
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "executor-web" },
              spans: [
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                  name: "http.client GET",
                  kind: 3,
                  startTimeUnixNano: "0",
                  endTimeUnixNano: "1",
                  attributes: [
                    {
                      key: "url.full",
                      value: {
                        stringValue: `https://app.test/api/oauth/callback?code=${SECRET}-code#access_token=${SECRET}-fragment`,
                      },
                    },
                    { key: "url.query", value: { stringValue: `code=${SECRET}-code` } },
                  ],
                  events: [
                    {
                      name: "exception",
                      timeUnixNano: "1",
                      attributes: [
                        {
                          key: "exception.message",
                          value: {
                            stringValue: `GET https://u:${SECRET}-userinfo@api.test/x?key=${SECRET}-key failed`,
                          },
                        },
                      ],
                    },
                  ],
                  status: {
                    code: 2,
                    message: `GET https://api.test/x?key=${SECRET}-status failed`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    let forwarded: string | undefined;
    const response = await browserTracesResponse(
      makeRequest({
        headers: { cookie: "wos-session=abc" },
        body: JSON.stringify(payload),
      }),
      baseEnv,
      (async (_url: RequestInfo | URL, init?: RequestInit) => {
        forwarded = await new Response(init?.body as BodyInit).text();
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    );
    expect(response?.status).toBe(204);
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toContain(SECRET);
    // Non-vacuous: the span, its route, and its trace identity survive.
    expect(forwarded).toContain("/api/oauth/callback");
    expect(forwarded).toContain("0af7651916cd43dd8448eb211c80319c");
    expect(forwarded).toContain("exception");
  });

  it("rejects an unparseable batch instead of forwarding it unscrubbed", async () => {
    let forwardedCount = 0;
    const response = await browserTracesResponse(
      makeRequest({
        headers: { cookie: "wos-session=abc" },
        body: `not-json ?token=synthetic-unparsed-secret`,
      }),
      baseEnv,
      (async () => {
        forwardedCount += 1;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    );
    expect(response?.status).toBe(400);
    expect(forwardedCount).toBe(0);
  });

  it("reports upstream failure as 502 without leaking detail", async () => {
    const response = await browserTracesResponse(
      makeRequest({ headers: { cookie: "wos-session=abc" } }),
      baseEnv,
      (async () => new Response("denied", { status: 403 })) as typeof fetch,
    );
    expect(response?.status).toBe(502);
  });

  it("refuses oversized batches", async () => {
    const response = await browserTracesResponse(
      makeRequest({
        headers: {
          cookie: "wos-session=abc",
          "content-length": String(3_000_000),
        },
      }),
      baseEnv,
    );
    expect(response?.status).toBe(413);
  });

  it("only accepts POST", async () => {
    const response = await browserTracesResponse(
      new Request("https://executor.sh/v1/traces", { method: "GET" }),
      baseEnv,
    );
    expect(response?.status).toBe(405);
  });
});
