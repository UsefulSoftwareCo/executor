/** Entry credentials must survive asynchronous auth gates before their consumers mount. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Redacted } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { pairingTokenAtom } from "./connection.ts";
import { oauthCallbackAtom } from "./oauth.ts";

test("entry callback and pairing token survive idle atom cleanup", async () => {
  const callback = Redacted.make(
    "http://127.0.0.1:4312/api/oauth/callback?code=synthetic&state=synthetic",
  );
  const pairing = Redacted.make("ab".repeat(32));
  const registry = AtomRegistry.make({
    initialValues: [
      [oauthCallbackAtom, callback],
      [pairingTokenAtom, pairing],
    ],
  });
  try {
    // Simulate the session and inventory requests before OAuthCallbackPage mounts.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(registry.get(oauthCallbackAtom), callback);
    assert.equal(registry.get(pairingTokenAtom), pairing);
  } finally {
    registry.dispose();
  }
});
