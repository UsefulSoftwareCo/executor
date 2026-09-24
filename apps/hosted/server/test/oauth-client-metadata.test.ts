import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOAuthClientMetadataUrl } from "../src/implementation/auth.ts";

test("hosted OAuth offers client metadata only on HTTPS origins", () => {
  assert.equal(
    accountOAuthClientMetadataUrl("https://v2.executor.sh"),
    "https://v2.executor.sh/api/oauth/client-id-metadata/default.json",
  );
  assert.equal(accountOAuthClientMetadataUrl("http://127.0.0.1:4400"), undefined);
});
