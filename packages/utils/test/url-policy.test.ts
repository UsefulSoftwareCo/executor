import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Schema } from "effect";
import {
  defaultUrlPolicy,
  HttpOrigin,
  parseDestination,
  parseEndpoint,
  redirectDestination,
  UrlPolicy,
  urlPolicyConfig,
} from "../src/url-policy.ts";

const configured: UrlPolicy = {
  allowLoopbackHttp: false,
  allowedHttpOrigins: [HttpOrigin.make("http://auth.internal:8080")],
};

test("transport defaults recognize reserved loopback hosts and reject lookalikes", () => {
  for (const host of [
    "localhost",
    "account-picker.localhost",
    "localhost.",
    "127.0.0.1",
    "127.12.0.2",
    "[::1]",
  ]) {
    assert.ok(parseEndpoint(`http://${host}:8080/callback?tenant=a`, defaultUrlPolicy));
    assert.equal(parseEndpoint(`http://${host}:8080/callback`, configured), undefined);
  }
  for (const host of [
    "localhost.evil.test",
    "notlocalhost",
    "127.0.0.1.evil.test",
    "10.0.0.1",
    "auth.internal",
  ])
    assert.equal(parseEndpoint(`http://${host}/callback`, defaultUrlPolicy), undefined);
  assert.ok(parseEndpoint("https://remote.test/callback?tenant=a", defaultUrlPolicy));
});

test("exceptions match whole origins without relaxing endpoint syntax", () => {
  assert.equal(
    parseEndpoint("http://auth.internal:8080/callback?tenant=a", configured)?.href,
    "http://auth.internal:8080/callback?tenant=a",
  );
  for (const value of [
    "http://auth.internal:8081/callback",
    "http://child.auth.internal:8080/callback",
    "http://auth.internal:8080.evil.test/callback",
    "http://user:pass@auth.internal:8080/callback",
    "http://auth.internal:8080/callback#",
    "https://safe.test/#fragment",
    "ftp://auth.internal/callback",
    "/callback",
  ])
    assert.equal(parseEndpoint(value, configured), undefined);
  for (const value of [
    "http://auth.internal/",
    "http://auth.internal/path",
    "http://auth.internal?tenant=a",
    "http://auth.internal#",
    "http://user@auth.internal",
    "http://*.internal",
    "https://auth.internal",
  ])
    assert.equal(Schema.is(HttpOrigin)(value), false, value);
});

const readConfig = (values: Record<string, string>) =>
  Effect.runPromise(
    urlPolicyConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
    ),
  );

test("hosts parse the same explicit policy and reject malformed configuration", async () => {
  assert.deepEqual(await readConfig({}), defaultUrlPolicy);
  assert.deepEqual(
    await readConfig({
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "false",
      EXECUTOR_URL_ALLOW_HTTP_ORIGINS: '["http://auth.internal:8080"]',
    }),
    configured,
  );
  for (const value of [
    '["http://*.internal"]',
    '["http://host/path"]',
    '["https://host"]',
    '"http://host"',
    "not-json",
  ])
    await assert.rejects(readConfig({ EXECUTOR_URL_ALLOW_HTTP_ORIGINS: value }));
});

const loopbackAllowed: UrlPolicy = { allowLoopbackHttp: true, allowedHttpOrigins: [] };
const publicOnly: UrlPolicy = { allowLoopbackHttp: false, allowedHttpOrigins: [] };

test("destinations refuse private and internal address space in both families", () => {
  for (const host of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[ff02::1]",
    "[::ffff:169.254.169.254]",
    "[::ffff:a00:5]",
    "[64:ff9b::7f00:1]",
    "metadata.google.internal",
    "consul.service.internal",
    "printer.local",
    "vault",
    "2130706433",
    "0x7f000001",
    "017700000001",
  ])
    assert.equal(parseDestination(`https://${host}/spec.json`, publicOnly), undefined, host);
  for (const host of ["api.example.com", "172.32.0.1", "11.0.0.1", "[2606:4700::1111]", "8.8.8.8"])
    assert.ok(parseDestination(`https://${host}/spec.json`, publicOnly), host);
});

test("loopback stays available for local development, and only for loopback", () => {
  for (const value of [
    "http://127.0.0.1:4312/openapi.json",
    "http://localhost:4312/openapi.json",
    "https://[::1]:4312/openapi.json",
  ])
    assert.ok(parseDestination(value, loopbackAllowed), value);
  for (const value of ["https://10.0.0.5/spec", "https://169.254.169.254/latest/meta-data/"])
    assert.equal(parseDestination(value, loopbackAllowed), undefined, value);
  // An explicit operator exception still names one exact origin and nothing beside it.
  assert.ok(parseDestination("http://auth.internal:8080/token", configured));
  assert.equal(parseDestination("http://auth.internal:8081/token", configured), undefined);
  assert.equal(parseDestination("https://auth.internal/token", configured), undefined);
});

test("destinations never widen the transport rule", () => {
  for (const value of [
    "http://api.example.com/spec",
    "ftp://api.example.com/spec",
    "https://user:pass@api.example.com/spec",
    "https://api.example.com/spec#frag",
    "/spec",
  ])
    assert.equal(parseDestination(value, publicOnly), undefined, value);
});

test("every redirect hop is re-checked against the policy that allowed the first", () => {
  assert.equal(
    redirectDestination("/v2/spec.json", "https://api.example.com/spec", publicOnly)?.href,
    "https://api.example.com/v2/spec.json",
  );
  for (const location of [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "//10.0.0.5/spec",
    "https://[::ffff:127.0.0.1]/spec",
  ])
    assert.equal(
      redirectDestination(location, "https://api.example.com/spec", publicOnly),
      undefined,
      location,
    );
  // A loopback deployment may follow a loopback hop, but not one into the LAN.
  assert.ok(redirectDestination("/spec.json", "http://127.0.0.1:4312/s", loopbackAllowed));
  assert.equal(
    redirectDestination("http://192.168.0.1/spec", "http://127.0.0.1:4312/s", loopbackAllowed),
    undefined,
  );
});
