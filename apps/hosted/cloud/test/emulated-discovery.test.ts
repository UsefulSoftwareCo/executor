/** Resolved provider metadata removes session-time discovery without bypassing OIDC verification. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { genericOAuth } from "better-auth/plugins";
import { Schema } from "effect";

test("resolved OIDC metadata avoids discovery reads and still rejects invalid tokens", async (context) => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let discoveryReads = 0;
  let keyReads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/keys") {
      keyReads++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          keys: [
            {
              ...keys.publicKey.export({ format: "jwk" }),
              kid: "fixture",
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
      );
    } else {
      discoveryReads++;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Discovery is unavailable after provisioning" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const issuer = `http://127.0.0.1:${address.port}`;
  const origin = "https://application.example.test";
  const auth = () =>
    betterAuth({
      baseURL: origin,
      secret: "Synthetic-discovery-secret-for-tests-2026",
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      plugins: [
        genericOAuth({
          config: [
            {
              providerId: "google",
              clientId: "fixture-client",
              clientSecret: "fixture-client-secret",
              discoveryUrl: `${issuer}/.well-known/openid-configuration`,
              discoveryDocument: {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                userinfo_endpoint: `${issuer}/userinfo`,
                jwks_uri: `${issuer}/keys`,
                id_token_signing_alg_values_supported: ["RS256"],
              },
              scopes: ["openid", "email", "profile"],
              pkce: true,
              requireIdTokenVerification: true,
            },
          ],
        }),
      ],
    });
  const request = (body: Readonly<Record<string, string | Readonly<Record<string, string>>>>) =>
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "google", ...body }),
    });
  for (let index = 0; index < 3; index++) {
    const response = await auth().handler(request({ callbackURL: "/login" }));
    assert.equal(
      response.status,
      200,
      "Every fresh auth instance must use the resolved provider metadata",
    );
    const result = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
      await response.json(),
    );
    const redirect = new URL(result.url);
    assert.equal(redirect.origin, issuer);
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.ok(redirect.searchParams.get("nonce"));
  }
  const token = (
    overrides: Record<string, string | number>,
    privateKey: KeyObject = keys.privateKey,
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: "fixture-client",
        sub: "fixture-user",
        email: "user@example.test",
        email_verified: true,
        name: "Fixture User",
        iat: now,
        exp: now + 120,
        nonce: "fixture-nonce",
        ...overrides,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  const native = auth();
  for (const invalid of [
    token({}, wrong.privateKey),
    token({ iss: `${issuer}/foreign` }),
    token({ aud: "another-client" }),
    token({ exp: 1 }),
    token({ nonce: "another-nonce" }),
  ]) {
    assert.equal(
      (await native.handler(request({ idToken: { token: invalid, nonce: "fixture-nonce" } })))
        .status,
      401,
    );
  }
  assert.equal(
    (await native.handler(request({ idToken: { token: token({}), nonce: "fixture-nonce" } })))
      .status,
    200,
  );
  assert.equal(discoveryReads, 0);
  assert.ok(keyReads > 0, "Signature verification must fetch the issuer's public keys");
});
