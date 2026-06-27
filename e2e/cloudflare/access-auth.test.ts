import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";

import {
  accessAssertionHeaders,
  issueCloudflareAccessToken,
  readCloudflareAccessLedger,
} from "../src/cloudflare-access-emulator";
import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";
import { CLOUDFLARE_ACCESS_BASE_URL } from "../targets/cloudflare";

scenario(
  "Cloudflare Access · a signed human assertion reaches the protected account API",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeClient(AccountHttpApi, identity);

    const me = yield* client.account.me();
    expect(me.user.email, "the verified Access email reaches the account surface").toBe(
      "admin@e2e.test",
    );
    expect(me.user.id, "the verified Access subject is the stable account id").toMatch(/^user-/);
    expect(me.organization?.id, "the Access principal belongs to the configured tenant").toBe(
      "default",
    );
    const ledger = yield* Effect.promise(() =>
      readCloudflareAccessLedger(CLOUDFLARE_ACCESS_BASE_URL),
    );
    const events = ledger.map(
      (entry) => `${entry.operation}:${entry.tokenKind ?? "none"}:${entry.status}`,
    );
    expect(
      events,
      "the Worker fetched the Access signing keys over the documented certs endpoint",
    ).toContain("jwks.read:none:200");
    expect(events, "the fixture records human issuance without recording the JWT").toContain(
      "token.issue:human:200",
    );
  }),
);

scenario(
  "Cloudflare Access · anonymous and wrong-audience human assertions are rejected",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const anonymous = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl)),
    );
    expect(anonymous.status, "the Worker does not rely on the old dev-auth bypass").toBe(401);

    const wrongAudience = yield* Effect.promise(() =>
      issueCloudflareAccessToken(CLOUDFLARE_ACCESS_BASE_URL, {
        kind: "human",
        subject: "wrong-audience-user",
        email: "admin@e2e.test",
        audience: "another-access-application",
      }),
    );
    const rejected = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl), {
        headers: accessAssertionHeaders(wrongAudience),
      }),
    );
    expect(rejected.status, "a valid signature cannot bypass the configured Access AUD").toBe(401);
  }),
);

scenario(
  "Cloudflare Access · a signed service-token assertion receives its machine identity",
  {},
  Effect.gen(function* () {
    const { client: makeClient } = yield* Api;
    const commonName = "executor-ci.access";
    // Access exchanges the raw client-id/client-secret pair at its edge. The
    // origin receives this signed application-token shape with common_name.
    const token = yield* Effect.promise(() =>
      issueCloudflareAccessToken(CLOUDFLARE_ACCESS_BASE_URL, {
        kind: "service",
        commonName,
      }),
    );
    const client = yield* makeClient(AccountHttpApi, {
      label: commonName,
      headers: accessAssertionHeaders(token),
    });

    const me = yield* client.account.me();
    expect(me.user.id, "the service-token client id is the stable account id").toBe(commonName);
    expect(me.user.name, "the machine identity remains recognizable").toBe(commonName);
    expect(me.user.email, "service tokens do not impersonate a human email").toBe("");
    const ledger = yield* Effect.promise(() =>
      readCloudflareAccessLedger(CLOUDFLARE_ACCESS_BASE_URL),
    );
    expect(
      ledger.map((entry) => `${entry.operation}:${entry.tokenKind ?? "none"}:${entry.status}`),
      "the fixture records service issuance without recording credentials or assertions",
    ).toContain("token.issue:service:200");
  }),
);

scenario(
  "Cloudflare Access · expired and tampered service-token assertions are rejected",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const expired = yield* Effect.promise(() =>
      issueCloudflareAccessToken(CLOUDFLARE_ACCESS_BASE_URL, {
        kind: "service",
        commonName: "expired-ci.access",
        expiresInSeconds: -60,
      }),
    );
    const expiredResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl), {
        headers: accessAssertionHeaders(expired),
      }),
    );
    expect(expiredResponse.status, "Access expiry is enforced by the Worker").toBe(401);

    const valid = yield* Effect.promise(() =>
      issueCloudflareAccessToken(CLOUDFLARE_ACCESS_BASE_URL, {
        kind: "service",
        commonName: "tampered-ci.access",
      }),
    );
    const [header, payload, signature] = valid.split(".");
    const tamperedSignature = `${signature?.startsWith("A") ? "B" : "A"}${signature?.slice(1) ?? ""}`;
    const tampered = `${header}.${payload}.${tamperedSignature}`;
    const tamperedResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/account/me", target.baseUrl), {
        headers: accessAssertionHeaders(tampered),
      }),
    );
    expect(tamperedResponse.status, "a forged service assertion never reaches the app").toBe(401);
  }),
);
