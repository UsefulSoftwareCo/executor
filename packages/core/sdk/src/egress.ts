// ---------------------------------------------------------------------------
// Egress guard — SSRF protection for integration-spec fetching.
//
// The generic add-by-URL path (OpenAPI/GraphQL/MCP) fetches attacker-
// controlled URLs server-side. Without a guard, a crafted spec URL pointing
// at 169.254.169.254 (cloud metadata), RFC1918 services, or link-local
// targets lets a tenant read internal state through the fetch feature every
// new user touches first.
//
// Design (extracted + generalized from the Google/Graph adapters' strict
// origin allowlists):
//
//   assertFetchable(url)
//     → parse + scheme check
//     → normalize the hostname (strip trailing dot; resolve decimal/octal/
//       hex integer IPv4 forms to a canonical dotted quad)
//     → resolve via dns.lookup (hostnames only; literal IPs skip DNS)
//     → classify the resolved address against the blocklist
//     → return PinnedTarget { url, hostname, resolvedAddress }
//
// The caller connects to `resolvedAddress` (pinning — no second resolution,
// so a DNS-rebinding attacker cannot swap a public answer for a private one
// between validate and connect). Classification is a pure function of the
// address string.
//
// The blocklist: loopback, RFC1918, link-local (incl. 169.254.169.254),
// carrier-grade NAT 100.64/10, IPv6 link-local + ULA, IPv4-mapped IPv6,
// 0.0.0.0, and broadcast.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

// DNS resolution is loaded lazily: this module is part of the SDK barrel,
// which DOM-platform consumers (react) typecheck against node-less libs —
// any statically resolvable "node:dns" import would break their
// compilation. Only the assertFetchable path needs it, and that path runs
// in Node runtimes. The specifier below is assembled at runtime so tsc
// does not resolve it under DOM libs.
type Lookup = (hostname: string) => Promise<{ address: string }[]>;
let cachedLookup: Lookup | undefined;
const loadNodeDeps = async (): Promise<{ lookup: Lookup }> => {
  if (cachedLookup !== undefined) return { lookup: cachedLookup };
  const dnsModuleName = ["node", "dns"].join(":");
  // Structurally typed: no resolvable node:dns type reference survives for
  // DOM-platform consumers of the SDK barrel.
  const dns: {
    promises: { lookup: (h: string, o: { all: true }) => Promise<{ address: string }[]> };
  } = await import(dnsModuleName);
  cachedLookup = (hostname: string) => dns.promises.lookup(hostname, { all: true });
  return { lookup: cachedLookup };
};

/** Family classifier without node:net — IPv4 validates via ipv4ToInt, IPv6
 *  via a strict colon-hex structural check. Mirrors net.isIP's 0/4/6. */
const classifyFamily = (address: string): 0 | 4 | 6 => {
  if (ipv4ToInt(address) !== null) return 4;
  const a = address.toLowerCase();
  // IPv6: 2-8 groups of 1-4 hex digits, at most one "::" (which may
  // compress leading/trailing zeros), optionally ending in an IPv4 tail.
  if (!a.includes(":")) return 0;
  const v4Tail = /(?<=:)(?:d{1,3}.){3}d{1,3}$/.test(a);
  const head = v4Tail ? a.slice(0, a.lastIndexOf(":")) : a;
  if (v4Tail && !/:(:)?$/.test(head) === false && head.replaceAll(":", "").length === 0) return 0;
  const groups = head.split("::");
  if (groups.length > 2) return 0;
  const parts =
    groups.length === 2 ? [...groups[0].split(":"), ...groups[1].split(":")] : head.split(":");
  const maxGroups = v4Tail ? 6 : 8;
  if (groups.length === 2 && parts.filter(Boolean).length > maxGroups) return 0;
  if (groups.length === 1 && parts.filter(Boolean).length !== maxGroups) return 0;
  return parts.every((p) => p === "" || /^[0-9a-f]{1,4}$/.test(p)) ? 6 : 0;
};

/** Rejection reason — kept coarse so error messages never leak topology. */
export class EgressError extends Schema.TaggedErrorClass<EgressError>()("EgressError", {
  reason: Schema.Literal("blocked_by_policy"),
}) {}

export type EgressErrorInstance = InstanceType<typeof EgressError>;

/** A validated, pinned target: connect to `resolvedAddress`, keep `hostname`
 *  for the Host header / SNI. */
export const PinnedTarget = Schema.Struct({
  url: Schema.String,
  hostname: Schema.String,
  /** The IP address the caller MUST connect to (pinned — no re-resolution). */
  resolvedAddress: Schema.String,
});
export type PinnedTarget = typeof PinnedTarget.Type;

// ---------------------------------------------------------------------------
// Pure classification — no I/O. Testable directly; the PBT property permutes
// encodings against it.
// ---------------------------------------------------------------------------

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
};

const inCidr = (ip: number, base: string, bits: number): boolean => {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : 0xffffffff << (32 - bits);
  return (ip & mask) === (baseInt & mask);
};

const isPrivateIPv4 = (ip: string): boolean => {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return (
    inCidr(value, "0.0.0.0", 8) || // "this network"
    inCidr(value, "10.0.0.0", 8) || // RFC1918
    inCidr(value, "127.0.0.0", 8) || // loopback
    inCidr(value, "169.254.0.0", 16) || // link-local incl. metadata
    inCidr(value, "172.16.0.0", 12) || // RFC1918
    inCidr(value, "192.168.0.0", 16) || // RFC1918
    inCidr(value, "100.64.0.0", 10) || // CGNAT
    inCidr(value, "255.255.255.255", 32) // broadcast
  );
};

const isPrivateIPv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — classify the embedded IPv4.
    return isPrivateIPv4(lower.slice("::ffff:".length));
  }
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("ff")) return true; // multicast
  return false;
};

/** True for any reserved/private/link-local/metadata address, IPv4 or IPv6,
 *  in canonical dotted-quad / colon-hex form. (Encoded forms are normalized
 *  by the caller before this runs.) */
export const isBlockedAddress = (address: string): boolean => {
  const family = classifyFamily(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // not parseable as an IP — treat as blocked (fail closed)
};

// ---------------------------------------------------------------------------
// Hostname normalization — DNS-encoding trick defense.
// ---------------------------------------------------------------------------

/** Normalize an integer-form IPv4 (decimal/octal/hex, single or dotted) to a
 *  canonical dotted quad, or null if the host is not an encoded IPv4 literal.
 *  Examples: 2852039166 → 169.254.169.254; 0x7f000001 → 127.0.0.1;
 *  0177.0.0.1 → 127.0.0.1. */
const normalizeEncodedIPv4 = (host: string): string | null => {
  const trimmed = host.replace(/\.$/, ""); // trailing dot
  // Hex form: 0x7f000001 or 0x7f.0x0.0x1 style
  if (/^0x/i.test(trimmed)) {
    const body = trimmed.slice(2);
    if (!/^[0-9a-f]+$/i.test(body)) return null;
    const value = parseInt(body, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
      ".",
    );
  }
  // Octal-per-octet: 0177.0.0.1 — ANY part with a leading 0 makes the whole
  // quad octal (C/browser URL-parsing rule), so every octet is base-8.
  if (trimmed.includes(".") && /(^|\.)0[0-7]+(\.|$)/.test(trimmed)) {
    const parts = trimmed.split(".");
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
      if (!/^[0-7]+$/.test(part)) return null;
      const octet = parseInt(part, 8);
      if (octet > 255) return null;
      octets.push(octet);
    }
    return octets.join(".");
  }
  // Single integer: 2852039166
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
      ".",
    );
  }
  return null;
};

/** Normalize a hostname for classification. Returns the canonical address if
 *  the host IS an IP literal (any encoding), else null (meaning: it's a
 *  hostname, resolve it). */
const normalizeHost = (host: string): string | null => {
  const trimmed = host.replace(/\.$/, "").toLowerCase();
  if (classifyFamily(trimmed) !== 0) return trimmed;
  const encoded = normalizeEncodedIPv4(trimmed);
  if (encoded !== null) return encoded;
  return null;
};

// ---------------------------------------------------------------------------
// Resolve + classify + pin.
// ---------------------------------------------------------------------------

const BLOCKED_MESSAGE = "Blocked by egress policy";

/** Options for assertFetchable. `allowLoopback` deliberately re-enables
 *  loopback/private targets for callers that have already decided to trust
 *  them (a local dev spec server, an e2e-hosted fixture). The default stays
 *  fail-closed; production paths never pass this. */
export interface FetchableOptions {
  readonly allowLoopback?: boolean;
}

/** Validate a URL's target. Resolves hostnames, classifies the address,
 *  returns a pinned target. Pure-IP literals (any encoding) are classified
 *  without DNS. */
export const assertFetchable = (
  url: string,
  lookupOrOptions?: ((hostname: string) => Promise<string[]>) | FetchableOptions,
  maybeOptions?: FetchableOptions,
): Effect.Effect<PinnedTarget, EgressError> => {
  const lookup =
    typeof lookupOrOptions === "function"
      ? lookupOrOptions
      : async (hostname: string) => {
          const { lookup: nodeLookup } = await loadNodeDeps();
          const addrs = await nodeLookup(hostname);
          return addrs.map((a) => a.address);
        };
  const options: FetchableOptions =
    typeof lookupOrOptions === "function" ? (maybeOptions ?? {}) : (lookupOrOptions ?? {});
  const allowLoopback = options.allowLoopback === true;
  return Effect.gen(function* () {
    let parsed: URL;
    // oxlint-disable executor/no-try-catch-or-throw -- boundary: untrusted user-supplied URL string; an unparseable URL collapses to the blocked error (fail closed)
    try {
      parsed = new URL(url);
    } catch {
      return yield* new EgressError({ reason: "blocked_by_policy" });
    }
    // oxlint-enable executor/no-try-catch-or-throw
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* new EgressError({ reason: "blocked_by_policy" });
    }
    if (parsed.username || parsed.password) {
      // userinfo in a spec URL is a credential-exfiltration smell — fail closed.
      return yield* new EgressError({ reason: "blocked_by_policy" });
    }

    const hostname = parsed.hostname;
    const canonical = normalizeHost(hostname);

    let resolvedAddresses: string[];
    if (canonical !== null) {
      // IP literal — classify directly, no DNS (a literal cannot rebind).
      resolvedAddresses = [canonical];
    } else {
      // Lookup failure (NXDOMAIN, resolver down) is treated as "no
      // addresses" — a success carrying an empty list, which the check
      // below turns into blocked. tryPromise's catch produces the ERROR
      // value, so mapping it to [] there would surface a nonsense error;
      // instead catch with a typed error and recover to the empty list.
      resolvedAddresses = yield* Effect.tryPromise({
        try: () => lookup(hostname),
        catch: () => new EgressError({ reason: "blocked_by_policy" }),
      }).pipe(Effect.orElseSucceed(() => []));
      if (resolvedAddresses.length === 0) {
        // allowLoopback means the deployment trusts its whole network for
        // this fetch — including its own resolver (e.g. a workerd host where
        // node:dns may be unavailable). Pass the hostname through as the
        // target and let the transport resolve it.
        if (allowLoopback) {
          return { url, hostname, resolvedAddress: hostname };
        }
        return yield* new EgressError({ reason: "blocked_by_policy" });
      }
    }

    // Fail closed if ANY resolved address is blocked (an attacker controls
    // DNS; a single private answer poisons the whole target). allowLoopback
    // is the explicit trust escape hatch — see FetchableOptions.
    if (!allowLoopback) {
      for (const address of resolvedAddresses) {
        if (isBlockedAddress(address)) {
          return yield* new EgressError({ reason: "blocked_by_policy" });
        }
      }
    }

    // Pin the FIRST address; the caller must connect to it and must
    // NOT re-resolve (DNS-rebinding defense).
    const pinned = resolvedAddresses[0];
    return { url, hostname, resolvedAddress: pinned };
  });
};

/** Coarse, topology-free message — never echo the resolved address. */
export const egressErrorMessage = (): string => BLOCKED_MESSAGE;
