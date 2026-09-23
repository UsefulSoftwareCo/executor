/** The login return path reaches window.location.replace, so it must stay on this origin. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserReturnTo } from "@executor-js/hosted-server/browser";

test("page destinations on this origin are preserved", () => {
  assert.equal(browserReturnTo("/apps"), "/apps");
  assert.equal(
    browserReturnTo("/org/alpha/apps/app_test?view=accounts"),
    "/org/alpha/apps/app_test?view=accounts",
  );
  assert.equal(
    browserReturnTo("/mcp/authorize?client_id=example&state=a%20b"),
    "/mcp/authorize?client_id=example&state=a%20b",
  );
  assert.equal(browserReturnTo("/apps#section"), "/apps#section");
  // A signed MCP authorization query carries an encoded redirect_uri.
  assert.equal(
    browserReturnTo("/mcp/authorize?redirect_uri=https%3A%2F%2Fclient.test%2Fcb"),
    "/mcp/authorize?redirect_uri=https%3A%2F%2Fclient.test%2Fcb",
  );
});

test("anything that normalizes to another origin returns to the root", () => {
  for (const value of [
    "//evil.test/",
    "/..//evil.test",
    "/.//evil.test",
    "/a/..//evil.test",
    "/%2e%2e//evil.test",
    "/..\\/evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    "https://evil.test/",
    "evil.test",
  ])
    assert.equal(browserReturnTo(value), "/", value);
});

test("auth and API paths remain excluded", () => {
  assert.equal(browserReturnTo("/login"), "/");
  assert.equal(browserReturnTo("/login/passkey"), "/");
  assert.equal(browserReturnTo("/api/auth/callback"), "/");
  assert.equal(browserReturnTo(undefined), "/");
});
