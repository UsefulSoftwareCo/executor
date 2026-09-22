/** URL-borne capabilities must not reach Sentry through a breadcrumb or a request URL. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { strippedBreadcrumb, strippedUrl } from "../src/implementation/error-reporting-client.ts";

test("a stripped URL keeps its path and loses its query and fragment", () => {
  assert.equal(strippedUrl("/oauth/callback?code=live-code&state=x"), "/oauth/callback");
  assert.equal(strippedUrl("/invite?invitation=capability-token"), "/invite");
  assert.equal(strippedUrl("/email/unsubscribe#token=capability"), "/email/unsubscribe");
  assert.equal(
    strippedUrl("https://cloud.test/mcp/authorize?state=x&code_challenge=y"),
    "https://cloud.test/mcp/authorize",
  );
  assert.equal(strippedUrl("/apps"), "/apps");
});

test("navigation, fetch and xhr breadcrumbs lose their URL parameters", () => {
  const crumb = strippedBreadcrumb({
    category: "navigation",
    data: {
      from: "/oauth/callback?code=live-code&state=x",
      to: "/oauth/callback",
      url: "/api/auth/callback?code=live-code",
      status_code: 200,
    },
  });
  assert.deepEqual(crumb.data, {
    from: "/oauth/callback",
    to: "/oauth/callback",
    url: "/api/auth/callback",
    status_code: 200,
  });
  assert.deepEqual(strippedBreadcrumb({ category: "console" }).data, undefined);
});
