import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { assertFetchable, isBlockedAddress } from "./egress";

// ---------------------------------------------------------------------------
// Focused tests — egress-guard classification boundaries and the pinned
// resolve/connect contract.
//
// assertFetchable is pure (DNS injected as a lookup fn), so these tests need
// no executor harness, no DB, no scope. Encoded-host permutations and
// redirect-chain behavior are covered by property tests elsewhere; these
// pin the classification boundaries and the pin-return contract.
// ---------------------------------------------------------------------------

const publicLookup = async (hostname: string): Promise<string[]> =>
  hostname === "petstore3.swagger.io" ? ["104.18.16.10"] : ["93.184.216.34"];

const run = (url: string, lookup = publicLookup) => Effect.runPromise(assertFetchable(url, lookup));

describe("isBlockedAddress (pure classification)", () => {
  it("blocks metadata, loopback, RFC1918, CGNAT, link-local", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true); // cloud metadata
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("100.64.0.1")).toBe(true); // CGNAT
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("104.18.16.10")).toBe(false);
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });

  it("blocks IPv6 loopback, link-local, ULA, and IPv4-mapped private", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true); // mapped loopback
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true); // mapped metadata
  });

  it("fails closed on unparseable input", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("assertFetchable (allowLoopback trust mode)", () => {
  it("allows a loopback literal when the option is set", async () => {
    const pinned = await Effect.runPromise(
      assertFetchable("http://127.0.0.1:8787/spec.json", { allowLoopback: true }),
    );
    expect(pinned.resolvedAddress).toBe("127.0.0.1");
  });

  it("passes the hostname through when the resolver yields nothing (trusted resolver)", async () => {
    const emptyLookup = async (): Promise<string[]> => [];
    const pinned = await Effect.runPromise(
      assertFetchable("http://fixture.local:8787/spec.json", emptyLookup, { allowLoopback: true }),
    );
    expect(pinned.hostname).toBe("fixture.local");
    expect(pinned.resolvedAddress).toBe("fixture.local");
  });

  it("still blocks an unresolvable hostname without the option (fail closed)", async () => {
    const emptyLookup = async (): Promise<string[]> => [];
    await expect(
      Effect.runPromise(assertFetchable("http://fixture.local:8787/spec.json", emptyLookup)),
    ).rejects.toMatchObject({ _tag: "EgressError" });
  });
});

describe("assertFetchable (resolve + classify + pin)", () => {
  it("accepts a public hostname and returns the pinned resolved address", async () => {
    const pinned = await run("https://petstore3.swagger.io/api/v3/openapi.json");
    expect(pinned.hostname).toBe("petstore3.swagger.io");
    expect(pinned.resolvedAddress).toBe("104.18.16.10");
    expect(pinned.url).toBe("https://petstore3.swagger.io/api/v3/openapi.json");
  });

  it("rejects a metadata literal without DNS (fail closed)", async () => {
    await expect(run("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });

  it("rejects a decimal-encoded metadata IP (2852039166 = 169.254.169.254)", async () => {
    await expect(run("http://2852039166/latest/meta-data/")).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });

  it("rejects a hex-encoded loopback (0x7f000001 = 127.0.0.1)", async () => {
    await expect(run("http://0x7f000001/")).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });

  it("rejects an octal-encoded loopback (0177.0.0.1 = 127.0.0.1)", async () => {
    await expect(run("http://0177.0.0.1/")).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });

  it("rejects a hostname that resolves to a private address (DNS-pinned check)", async () => {
    const privateResolvingLookup = async (): Promise<string[]> => ["10.0.0.5"];
    await expect(run("http://evil.example.com/", privateResolvingLookup)).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });

  it("rejects a hostname that resolves to ANY private address among public ones", async () => {
    const mixedLookup = async (): Promise<string[]> => ["104.18.16.10", "169.254.169.254"];
    await expect(run("http://evil.example.com/", mixedLookup)).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });

  it("rejects non-http(s) schemes and userinfo", async () => {
    await expect(run("file:///etc/passwd")).rejects.toMatchObject({ _tag: "EgressError" });
    await expect(run("ftp://example.com/")).rejects.toMatchObject({ _tag: "EgressError" });
    await expect(run("http://user:pass@example.com/")).rejects.toMatchObject({
      _tag: "EgressError",
    });
  });
});
