import { describe, expect, it } from "@effect/vitest";

import {
  redactOtlpTraceExport,
  redactSpanUrlAttributes,
  redactUrlForTelemetry,
  redactUrlsInText,
} from "./telemetry-url-redaction";

// Synthetic placeholders only — never a real authorization code or state.
const CODE = "synthetic-authorization-code";
const STATE = "synthetic-csrf-state";

const callbackUrl = `https://app.test/api/oauth/callback?code=${CODE}&state=${STATE}&domain=example.test`;

describe("redactSpanUrlAttributes", () => {
  it("strips every query value from url.full and url.query", () => {
    const attributes: Record<string, unknown> = {
      "url.full": callbackUrl,
      "url.query": `code=${CODE}&state=${STATE}&domain=example.test`,
      "url.path": "/api/oauth/callback",
      "http.request.method": "GET",
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["code", "domain", "state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    // Route-level visibility is preserved; no query value is.
    expect(attributes["url.path"]).toBe("/api/oauth/callback");
    expect(attributes["url.full"]).toBe("https://app.test/api/oauth/callback");
    expect(attributes["url.query"]).toBe("");
  });

  it("drops a secret riding under any parameter name — names are never trusted", () => {
    // Query-auth placement names are arbitrary strings: a key configured as
    // `?owner=…` or `?error=…` is exactly as much a credential as `?key=…`.
    // That is why no allowlist of "safe" names can exist.
    const attributes: Record<string, unknown> = {
      "url.full":
        "https://api.test/graphql?owner=synthetic-owner-secret&error=synthetic-error-secret",
      "url.query": "owner=synthetic-owner-secret&error=synthetic-error-secret",
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["error", "owner"]);
    expect(JSON.stringify(attributes)).not.toContain("synthetic-owner-secret");
    expect(JSON.stringify(attributes)).not.toContain("synthetic-error-secret");
    expect(attributes["url.full"]).toBe("https://api.test/graphql");
  });

  it("drops a nested returnTo value wholesale — code, state, and userinfo included", () => {
    // The login redirect round-trips the whole OAuth callback URL through
    // `returnTo`, so credentials ride inside another parameter's value. The
    // value is dropped with every other query value; nothing nested survives.
    const returnTo = encodeURIComponent(
      `https://canary:synthetic-nested-userinfo-secret@app.test/api/oauth/callback?code=${CODE}&state=${STATE}`,
    );
    const attributes: Record<string, unknown> = {
      "url.full": `https://app.test/login?returnTo=${returnTo}`,
      "url.query": `returnTo=${returnTo}`,
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["returnTo"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    expect(JSON.stringify(attributes)).not.toContain("synthetic-nested-userinfo-secret");
    expect(attributes["url.full"]).toBe("https://app.test/login");
  });

  it("reports a nameless query segment as *, never by its text", () => {
    // `?<token>` parses as a parameter NAME — echoing it would leak the token
    // through the stripped-keys list.
    const attributes: Record<string, unknown> = {
      "url.full": "https://api.test/hook?synthetic-bare-token-secret",
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["*"]);
    expect(JSON.stringify(attributes)).not.toContain("synthetic-bare-token-secret");
    expect(attributes["url.full"]).toBe("https://api.test/hook");
  });

  it("clears a fragment-borne token from a parseable URL", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://app.test/callback#access_token=synthetic-fragment-token",
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["fragment"]);
    expect(JSON.stringify(attributes)).not.toContain("synthetic-fragment-token");
    expect(attributes["url.full"]).toBe("https://app.test/callback");
  });

  it("clears a fragment-borne token from a malformed URL", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "http://exa mple.test/callback#access_token=synthetic-fragment-token",
    };

    redactSpanUrlAttributes(attributes);

    expect(JSON.stringify(attributes)).not.toContain("synthetic-fragment-token");
    expect(attributes["url.full"]).toBe("http://exa mple.test/callback");
  });

  it("does not treat an @ inside the fragment as userinfo", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "http://exa mple.test/docs#note@anchor",
    };

    redactSpanUrlAttributes(attributes);

    expect(attributes["url.full"]).toBe("http://exa mple.test/docs");
  });

  it("strips userinfo from a URL attribute", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://svc:synthetic-basic-password@api.test/graphql",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["userinfo"]);
    expect(attributes["url.full"]).toBe("https://api.test/graphql");
    expect(JSON.stringify(attributes)).not.toContain("synthetic-basic-password");
  });

  it("scrubs a URL embedded in a free-text attribute", () => {
    const attributes: Record<string, unknown> = {
      "error.message": "request to https://api.test/graphql?key=synthetic-key failed",
    };

    redactSpanUrlAttributes(attributes);

    expect(attributes["error.message"]).toBe("request to https://api.test/graphql failed");
  });

  it("degrades an unparseable URL attribute instead of passing it through", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "http://exa mple.test/graphql?key=synthetic-key",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["key"]);
    expect(attributes["url.full"]).toBe("http://exa mple.test/graphql");
  });

  it("redacts the string elements of an array attribute value in place", () => {
    // OTel attributes permit string[] values — an array element carries a
    // credential-bearing URL exactly as a scalar does. Non-string elements
    // pass through untouched and the array keeps its identity.
    const SECRET = "synthetic-array-element-secret";
    const urlArray = [`https://canary:${SECRET}@host.test/graphql?key=${SECRET}`, 42];
    const attributes: Record<string, unknown> = {
      "url.full": urlArray,
      "url.query": [`key=${SECRET}`, 7],
      "error.notes": [`request to https://api.test/graphql?key=${SECRET} failed`, true],
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["key", "userinfo"]);
    expect(JSON.stringify(attributes)).not.toContain(SECRET);
    expect(attributes["url.full"]).toBe(urlArray);
    expect(attributes["url.full"]).toEqual(["https://host.test/graphql", 42]);
    expect(attributes["url.query"]).toEqual(["", 7]);
    expect(attributes["error.notes"]).toEqual(["request to https://api.test/graphql failed", true]);
  });

  it("leaves a query-, fragment-, and userinfo-free URL untouched", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://app.test/api/integrations",
      "url.path": "/api/integrations",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual([]);
    expect(attributes["url.full"]).toBe("https://app.test/api/integrations");
  });
});

describe("redactUrlForTelemetry", () => {
  it("strips query, fragment, and userinfo together", () => {
    const result = redactUrlForTelemetry(
      "https://svc:synthetic-pass@api.test/x?owner=synthetic-q#access_token=synthetic-f",
    );
    expect(result.url).toBe("https://api.test/x");
    expect(result.stripped).toEqual(["fragment", "owner", "userinfo"]);
  });

  it("returns a clean URL unchanged", () => {
    expect(redactUrlForTelemetry("https://api.test/x")).toEqual({
      url: "https://api.test/x",
      stripped: [],
    });
  });
});

describe("redactUrlsInText", () => {
  it("scrubs userinfo, query values, and fragments from embedded URLs", () => {
    const text = `Transport: fetch failed (GET https://u:synthetic-pass@api.test/x?key=synthetic-key#t=synthetic-frag)`;
    expect(redactUrlsInText(text)).toBe("Transport: fetch failed (GET https://api.test/x)");
  });
});

describe("redactOtlpTraceExport", () => {
  it("scrubs every channel of a serialized OTLP batch", () => {
    const SECRET = "synthetic-otlp-secret";
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
                  attributes: [
                    {
                      key: "url.full",
                      value: {
                        stringValue: `https://u:${SECRET}-userinfo@api.test/x?owner=${SECRET}-query#t=${SECRET}-fragment`,
                      },
                    },
                    { key: "url.query", value: { stringValue: `owner=${SECRET}-query` } },
                    {
                      key: "http.url",
                      // Malformed on purpose: the free-text regex alone would
                      // not match it, so the key-aware path must.
                      value: { stringValue: `http://exa mple.test/x?key=${SECRET}-malformed` },
                    },
                  ],
                  events: [
                    {
                      name: "exception",
                      attributes: [
                        {
                          key: "exception.message",
                          value: {
                            stringValue: `GET https://api.test/x?key=${SECRET}-event failed`,
                          },
                        },
                      ],
                    },
                  ],
                  status: {
                    code: 2,
                    message: `GET https://api.test/x?key=${SECRET}-status failed`,
                  },
                  links: [
                    {
                      traceId: "0af7651916cd43dd8448eb211c80319c",
                      spanId: "00f067aa0ba902b7",
                      attributes: [
                        {
                          key: "peer.url",
                          value: { stringValue: `https://api.test/x?key=${SECRET}-link` },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const serialized = JSON.stringify(redactOtlpTraceExport(payload));

    expect(serialized).not.toContain(SECRET);
    // Non-vacuous: identity, route, and structure survive the scrub.
    expect(serialized).toContain("0af7651916cd43dd8448eb211c80319c");
    expect(serialized).toContain("https://api.test/x");
    expect(serialized).toContain("exception");
    expect(serialized).toContain("http://exa mple.test/x");
  });

  it("scrubs the sibling fields of a URL-keyed KeyValue instead of passing them through", () => {
    // The URL-aware KeyValue special case must not exempt the REST of that
    // object from the walk: a crafted KeyValue can carry URL-bearing text in a
    // sibling of `key`/`value.stringValue`, and the browser-traces forwarder
    // feeds attacker-shaped JSON straight through this function.
    const SECRET = "synthetic-keyvalue-sibling-secret";
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    {
                      key: "url.full",
                      value: {
                        stringValue: "https://api.test/x?owner=synthetic-keyvalue-main-secret",
                        extraValue: `see https://api.test/x?owner=${SECRET}-inner`,
                      },
                      note: `retry of https://api.test/x?owner=${SECRET}-sibling`,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const serialized = JSON.stringify(redactOtlpTraceExport(payload));

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("synthetic-keyvalue-main-secret");
    // Non-vacuous: the redacted URL survives in every field.
    expect(serialized).toContain("https://api.test/x");
  });

  it("drops content past the nesting bound rather than forwarding it unexamined", () => {
    let deep: unknown = "https://api.test/x?key=synthetic-deep-secret";
    for (let index = 0; index < 200; index += 1) deep = [deep];
    const serialized = JSON.stringify(redactOtlpTraceExport({ resourceSpans: deep }));
    expect(serialized).not.toContain("synthetic-deep-secret");
  });
});
