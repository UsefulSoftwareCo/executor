import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  CLIENT_IP_HEADER,
  PROXY_HINT_HEADERS,
  clientIpAddressOptions,
  makeClientIpStamper,
  parseIpRange,
} from "./client-ip";

const signIn = (headers: Record<string, string> = {}) =>
  new Request("https://host.example/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "a@example.com", password: "pw" }),
  });

describe("parseIpRange", () => {
  it("accepts bare IPv4/IPv6 addresses as single-host ranges", () => {
    expect(parseIpRange("192.0.2.10")).toEqual({
      address: "192.0.2.10",
      prefix: 32,
      family: "ipv4",
    });
    expect(parseIpRange("2001:db8::1")).toEqual({
      address: "2001:db8::1",
      prefix: 128,
      family: "ipv6",
    });
  });

  it("accepts CIDR ranges within the family's prefix length", () => {
    expect(parseIpRange("10.0.0.0/8")).toEqual({ address: "10.0.0.0", prefix: 8, family: "ipv4" });
    expect(parseIpRange("2001:db8::/32")).toEqual({
      address: "2001:db8::",
      prefix: 32,
      family: "ipv6",
    });
  });

  it.each(["", "proxy", "10.0.0/8", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/8/8", "::/129"])(
    "rejects %j",
    (raw) => {
      expect(parseIpRange(raw)).toBeUndefined();
    },
  );
});

describe("clientIpAddressOptions", () => {
  it("reads only the stamped header, with no trusted proxies, when no proxy is configured", () => {
    expect(clientIpAddressOptions(undefined)).toStrictEqual({
      ipAddressHeaders: [CLIENT_IP_HEADER],
    });
  });

  it("reads the proxy header first, then the stamped header, and trusts the proxy ranges", () => {
    expect(
      clientIpAddressOptions({ header: "cf-connecting-ip", proxies: ["10.0.0.0/8", "192.0.2.10"] }),
    ).toStrictEqual({
      ipAddressHeaders: ["cf-connecting-ip", CLIENT_IP_HEADER],
      trustedProxies: ["10.0.0.0/8", "192.0.2.10"],
    });
  });
});

describe("makeClientIpStamper without a trusted proxy", () => {
  // The warning path has its own suite below; keep it out of this one's output.
  const stamp = makeClientIpStamper(undefined, { warn: () => {} });

  it("overwrites a client-supplied header with the socket peer address", async () => {
    const out = stamp(signIn({ [CLIENT_IP_HEADER]: "203.0.113.9" }), Option.some("198.51.100.4"));
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.4");
  });

  it("gives two socket peers two different stamps", () => {
    const a = stamp(signIn(), Option.some("198.51.100.4"));
    const b = stamp(signIn(), Option.some("198.51.100.5"));
    expect(a.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.4");
    expect(b.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.5");
  });

  it("removes a client-supplied header when the runtime reports no peer", () => {
    const out = stamp(signIn({ [CLIENT_IP_HEADER]: "203.0.113.9" }), Option.none());
    expect(out.headers.has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("preserves method, URL, other headers, and body", async () => {
    const out = stamp(signIn({ "x-forwarded-for": "203.0.113.9" }), Option.some("198.51.100.4"));
    expect(out.method).toBe("POST");
    expect(out.url).toBe("https://host.example/api/auth/sign-in/email");
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(out.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(await out.json()).toEqual({ email: "a@example.com", password: "pw" });
  });

  // The Vite dev middleware builds the request over a stream the runtime did
  // not create itself (`Readable.toWeb(req)`); the stamped request must still
  // deliver it in full.
  it("passes a streamed body through", async () => {
    const payload = JSON.stringify({ email: "a@example.com", password: "pw" });
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
      duplex: "half",
    };
    const streamed = new Request("https://host.example/api/auth/sign-in/email", init);
    const out = stamp(streamed, Option.some("198.51.100.4"));
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.4");
    expect(await out.text()).toBe(payload);
  });

  it("stamps a bodiless request without inventing a body", () => {
    const out = stamp(
      new Request("https://host.example/api/auth/get-session", { method: "GET" }),
      Option.some("198.51.100.4"),
    );
    expect(out.method).toBe("GET");
    expect(out.body).toBeNull();
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.4");
  });
});

describe("makeClientIpStamper behind a trusted proxy", () => {
  const stamp = makeClientIpStamper({
    header: "x-real-ip",
    proxies: ["10.0.0.0/8", "2001:db8::/32"],
  });

  it("keeps the proxy header on a connection from a trusted proxy", () => {
    const out = stamp(signIn({ "x-real-ip": "203.0.113.9" }), Option.some("10.1.2.3"));
    expect(out.headers.get("x-real-ip")).toBe("203.0.113.9");
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("10.1.2.3");
  });

  it("matches an IPv4 proxy reported as an IPv4-mapped IPv6 peer", () => {
    const out = stamp(signIn({ "x-real-ip": "203.0.113.9" }), Option.some("::ffff:10.1.2.3"));
    expect(out.headers.get("x-real-ip")).toBe("203.0.113.9");
  });

  it("matches an IPv6 proxy range", () => {
    const out = stamp(signIn({ "x-real-ip": "203.0.113.9" }), Option.some("2001:db8:1::7"));
    expect(out.headers.get("x-real-ip")).toBe("203.0.113.9");
  });

  it("strips the proxy header on a direct connection from an untrusted peer", () => {
    const out = stamp(signIn({ "x-real-ip": "203.0.113.9" }), Option.some("198.51.100.4"));
    expect(out.headers.has("x-real-ip")).toBe(false);
    expect(out.headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.4");
  });

  it("strips the proxy header when the runtime reports no peer", () => {
    const out = stamp(signIn({ "x-real-ip": "203.0.113.9" }), Option.none());
    expect(out.headers.has("x-real-ip")).toBe(false);
    expect(out.headers.has(CLIENT_IP_HEADER)).toBe(false);
  });
});

describe("unconfigured-proxy warning", () => {
  const stamperWithWarnings = (trustedProxy?: { header: string; proxies: string[] }) => {
    const warnings: string[] = [];
    const stamp = makeClientIpStamper(trustedProxy, {
      warn: (message) => {
        warnings.push(message);
      },
    });
    return { stamp, warnings };
  };

  it.each(PROXY_HINT_HEADERS)(
    "fires once for %s with no trusted proxy configured, naming both variables",
    (header) => {
      const { stamp, warnings } = stamperWithWarnings();
      stamp(signIn({ [header]: "203.0.113.9" }), Option.some("172.18.0.2"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(header);
      expect(warnings[0]).toContain("EXECUTOR_TRUSTED_PROXY_HEADER");
      expect(warnings[0]).toContain("EXECUTOR_TRUSTED_PROXIES");

      stamp(signIn({ [header]: "203.0.113.9" }), Option.some("172.18.0.2"));
      stamp(signIn({ "x-forwarded-for": "203.0.113.10" }), Option.some("172.18.0.2"));
      expect(warnings).toHaveLength(1);
    },
  );

  it("does not fire for a request without a proxy-style header", () => {
    const { stamp, warnings } = stamperWithWarnings();
    stamp(signIn(), Option.some("198.51.100.4"));
    stamp(signIn({ [CLIENT_IP_HEADER]: "203.0.113.9" }), Option.some("198.51.100.4"));
    expect(warnings).toHaveLength(0);
  });

  it("does not fire when a trusted proxy is configured", () => {
    const { stamp, warnings } = stamperWithWarnings({
      header: "x-real-ip",
      proxies: ["172.18.0.2"],
    });
    // From the proxy, with the configured header plus the extras nginx sends.
    stamp(
      signIn({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" }),
      Option.some("172.18.0.2"),
    );
    // Direct from an untrusted peer asserting a proxy header.
    stamp(signIn({ "x-forwarded-for": "203.0.113.9" }), Option.some("198.51.100.4"));
    expect(warnings).toHaveLength(0);
  });
});
