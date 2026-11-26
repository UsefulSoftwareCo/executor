import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { applySetCookies, splitSetCookieHeader } from "better-auth/cookies";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { getGooglePublicKey, github } from "better-auth/social-providers";

const redirectedJwk = {
  kty: "RSA",
  n: "z1SP_mnWgCxTAEptaVgsCGCfjPCV0nOHu5iqmLtANbVQJlcl-XgGKSyoPcBFn6IJ4Q8nGBhrWhugYqnl3ZhffW8YtAJb-XgZqfLNVrRDcMjV7tlEP5QcGxKlqjGatvSntg_6iXMNG59_GVEZVN3RVMblqp0Btzxp3Kwaz8mvC8aS8KoaUFJ1sp8rscQOVO2XuCDud39wlLQ8ommqXF3YV6k8EkwWFVkrV956tsRlI0i_u7mFPIjlGLpIPzGApYyNxJz-Zeeki3Jwod6dDcDq6enFUZ_e7sSF3y_a14Ai6ED3i14TzMgXrX_Uq-_Bzr1R8IakIO30CLsDo5lV_6BCFw",
  e: "AQAB",
  alg: "RS256",
  kid: "redirected-key",
};

const redirect = () =>
  new Response(null, {
    status: 307,
    headers: { location: "https://redirect-target.invalid/collect" },
  });

const opaqueRedirect = () => {
  const response = new Response(null);
  Object.defineProperties(response, {
    ok: { value: false },
    status: { value: 0 },
    type: { value: "opaqueredirect" },
  });
  return response;
};

const provider = github({ clientId: "synthetic-client", clientSecret: "synthetic-secret" });
const originalFetch = globalThis.fetch;
const followed = [];
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assert.equal(init?.redirect, "manual");
  if (init.redirect === "manual") return redirect();
  followed.push(url);
  return Response.json({ access_token: "redirected-access", token_type: "bearer" });
};
try {
  await assert.rejects(
    provider.validateAuthorizationCode({
      code: "synthetic-code",
      codeVerifier: "synthetic-verifier",
      redirectURI: "https://executor.example/api/auth/callback/github",
    }),
    /returned an HTTP redirect/u,
  );
  await assert.rejects(getGooglePublicKey(redirectedJwk.kid), /returned an HTTP redirect/u);
  assert.deepEqual(followed, []);
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => opaqueRedirect();
try {
  await assert.rejects(
    provider.validateAuthorizationCode({
      code: "synthetic-code",
      codeVerifier: "synthetic-verifier",
      redirectURI: "https://executor.example/api/auth/callback/github",
    }),
    /returned an HTTP redirect/u,
  );
} finally {
  globalThis.fetch = originalFetch;
}

const fetched = [];
globalThis.fetch = async (input, init) => {
  assert.equal(init?.redirect, "manual");
  const url = input instanceof Request ? input.url : String(input);
  fetched.push(url);
  if (url === "https://github.com/login/oauth/access_token") {
    return Response.json({ access_token: "direct-access", token_type: "bearer" });
  }
  assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
  return Response.json({ keys: [redirectedJwk] });
};
try {
  assert.equal(
    (
      await provider.validateAuthorizationCode({
        code: "synthetic-code",
        codeVerifier: "synthetic-verifier",
        redirectURI: "https://executor.example/api/auth/callback/github",
      })
    ).accessToken,
    "direct-access",
  );
  assert.ok(await getGooglePublicKey(redirectedJwk.kid));
  assert.deepEqual(fetched, [
    "https://github.com/login/oauth/access_token",
    "https://www.googleapis.com/oauth2/v3/certs",
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

const database = new DatabaseSync(":memory:");
const authOptions = {
  baseURL: "http://localhost:3000",
  database,
  emailAndPassword: { enabled: true },
  plugins: [admin()],
  rateLimit: { enabled: false },
  secret: "synthetic-secret-that-is-long-enough-for-better-auth",
};
await (await getMigrations(authOptions)).runMigrations();
const auth = betterAuth(authOptions);
await auth.api.signUpEmail({
  body: {
    email: "admin@example.test",
    name: "Admin",
    password: "synthetic-password",
  },
});
const context = await auth.$context;
const adminUser = (await context.internalAdapter.findUserByEmail("admin@example.test"))?.user;
assert.ok(adminUser);
await context.internalAdapter.updateUser(adminUser.id, { role: "admin" });
const signedIn = await auth.api.signInEmail({
  body: { email: "admin@example.test", password: "synthetic-password" },
  returnHeaders: true,
});
const headers = new Headers();
applySetCookies(headers, splitSetCookieHeader(signedIn.headers.get("set-cookie") ?? ""));

const target = await context.internalAdapter.createUser(
  {
    email: "security-control@example.test",
    emailVerified: false,
    name: "Security Control",
  },
  { method: "admin" },
);
await assert.rejects(
  auth.api.adminUpdateUser({
    body: { userId: target.id, data: { id: "replacement-user-id" } },
    headers,
  }),
  (error) => error?.body?.code === "USER_ID_CANNOT_BE_UPDATED",
);
assert.ok(await context.internalAdapter.findUserById(target.id));
assert.equal(await context.internalAdapter.findUserById("replacement-user-id"), null);

const updated = await auth.api.adminUpdateUser({
  body: { userId: target.id, data: { name: "Updated Security Control" } },
  headers,
});
assert.equal(updated.name, "Updated Security Control");

await context.internalAdapter.updateUser(target.id, { banned: true });
await assert.rejects(
  context.internalAdapter.createSession(target.id),
  (error) => error?.body?.code === "BANNED_USER",
);
await context.internalAdapter.updateUser(target.id, {
  banned: true,
  banExpires: new Date(Date.now() - 1_000),
  banReason: "expired control",
});
assert.equal((await context.internalAdapter.createSession(target.id)).userId, target.id);
assert.deepEqual(
  {
    banned: (await context.internalAdapter.findUserById(target.id))?.banned,
    banExpires: (await context.internalAdapter.findUserById(target.id))?.banExpires,
    banReason: (await context.internalAdapter.findUserById(target.id))?.banReason,
  },
  { banned: false, banExpires: null, banReason: null },
);
database.close();
console.log("Better Auth security boundaries passed.");
