/** The consent screen names the destination, which a registered client cannot fake. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { consentDestination } from "@executor-js/ui/dashboard/mcp-consent";

test("the redirect destination is reduced to its origin", () => {
  assert.equal(consentDestination("https://client.example/callback?x=1"), "https://client.example");
  assert.equal(consentDestination("http://127.0.0.1:8912/cb"), "http://127.0.0.1:8912");
  assert.equal(consentDestination("myclient://auth/cb"), "myclient://");
});

test("a missing or unreadable redirect shows no destination", () => {
  assert.equal(consentDestination(null), undefined);
  assert.equal(consentDestination(""), undefined);
  assert.equal(consentDestination("not a url"), undefined);
});
