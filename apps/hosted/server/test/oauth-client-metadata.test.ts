import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOAuthClientMetadata, clientMetadataUrls } from "../src/implementation/auth.ts";

const origin = "https://v2.executor.sh";
const defaultClientMetadataUrl = `${origin}/api/oauth/client-id-metadata/default.json`;

test("hosted OAuth defaults to a metadata URL only on public HTTPS hosts", () => {
  assert.deepEqual(clientMetadataUrls(origin), { clientMetadataUrl: defaultClientMetadataUrl });
  for (const privateOrigin of [
    "http://127.0.0.1:4400",
    "https://executor.localhost",
    "https://10.0.0.2",
    "https://dashboard.internal",
  ])
    assert.deepEqual(clientMetadataUrls(privateOrigin), {});
});

test("a configured metadata URL takes precedence over the hosted default", () => {
  assert.deepEqual(clientMetadataUrls(origin, "  "), {
    clientMetadataUrl: defaultClientMetadataUrl,
  });
  assert.deepEqual(clientMetadataUrls(origin, " https://custom.example/c.json "), {
    clientMetadataUrl: "https://custom.example/c.json",
  });
  assert.deepEqual(clientMetadataUrls("http://127.0.0.1:4400", "https://custom.example/c.json"), {
    clientMetadataUrl: "https://custom.example/c.json",
  });
});

test("the served document identifies itself by the default metadata URL", () => {
  const document = accountOAuthClientMetadata({ origin, oauthRedirectUri: undefined });
  assert.equal(document.client_id, defaultClientMetadataUrl);
  assert.deepEqual(document.redirect_uris, [`${origin}/api/oauth/callback`]);
});
