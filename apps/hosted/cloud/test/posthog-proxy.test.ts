import assert from "node:assert/strict";
import { test } from "node:test";
import { postHogUpstream } from "../src/implementation/product-analytics.ts";

test("proxy uses fixed regional targets and strips product credentials", () => {
  const request = new Request("https://example.test/api/0123456789abcdef/i/v0/e/?ip=1", {
    method: "POST",
    body: "events",
    headers: {
      authorization: "Bearer synthetic",
      cookie: "session=synthetic",
      "content-type": "text/plain",
      "content-encoding": "gzip",
    },
  });
  const upstream = postHogUpstream(request, {
    host: "https://us.i.posthog.com",
    path: "/api/0123456789abcdef",
  });
  assert.ok(upstream);
  assert.equal(upstream.url, "https://us.i.posthog.com/i/v0/e/?ip=1");
  assert.equal(upstream.headers.get("authorization"), null);
  assert.equal(upstream.headers.get("cookie"), null);
  assert.equal(upstream.headers.get("content-type"), "text/plain");
  assert.equal(upstream.headers.get("content-encoding"), "gzip");
});

test("SDK assets use the regional asset host and management endpoints are rejected", () => {
  const config = { host: "https://eu.i.posthog.com", path: "/api/0123456789abcdef" };
  assert.equal(
    postHogUpstream(
      new Request("https://example.test/api/0123456789abcdef/static/array.js"),
      config,
    )?.url,
    "https://eu-assets.i.posthog.com/static/array.js",
  );
  assert.equal(
    postHogUpstream(new Request("https://example.test/api/auth/get-session"), config),
    undefined,
  );
  assert.equal(
    postHogUpstream(
      new Request("https://example.test/api/0123456789abcdef/api/organizations/"),
      config,
    ),
    undefined,
  );
  assert.equal(
    postHogUpstream(
      new Request("https://example.test/api/0123456789abcdef//attacker.test/"),
      config,
    ),
    undefined,
  );
});

test("neutral capture URLs rewrite to ingestion without forwarding caller query parameters", () => {
  const upstream = postHogUpstream(
    new Request("https://example.test/api/0123456789abcdef/push?untrusted=value", {
      method: "POST",
      body: "{}",
    }),
    { host: "https://us.i.posthog.com", path: "/api/0123456789abcdef" },
  );
  assert.ok(upstream);
  assert.equal(upstream.url, "https://us.i.posthog.com/e/?ip=0");
});
