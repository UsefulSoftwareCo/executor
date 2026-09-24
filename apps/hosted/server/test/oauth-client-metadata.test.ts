import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOAuthClientMetadataUrl } from "../src/implementation/auth.ts";

test("hosted OAuth defaults to a publicly addressable HTTPS metadata URL", () => {
  assert.equal(
    accountOAuthClientMetadataUrl("https://v2.executor.sh"),
    "https://v2.executor.sh/api/oauth/client-id-metadata/default.json",
  );
  assert.equal(accountOAuthClientMetadataUrl("http://127.0.0.1:4400"), undefined);
  assert.equal(accountOAuthClientMetadataUrl("https://executor.localhost"), undefined);
  assert.equal(accountOAuthClientMetadataUrl("https://10.0.0.2"), undefined);
  assert.equal(accountOAuthClientMetadataUrl("https://dashboard.internal"), undefined);
});
