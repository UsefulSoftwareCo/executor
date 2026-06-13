import { describe, expect, it } from "@effect/vitest";

import { browserOriginFromRequest } from "./request-origin";

const req = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { headers });

describe("browserOriginFromRequest", () => {
  it("uses the request URL origin when no proxy headers are present (Cloudflare)", () => {
    expect(browserOriginFromRequest(req("https://executor.sh/acme/policies"))).toBe(
      "https://executor.sh",
    );
  });

  it("honors X-Forwarded-Proto to recover https behind a TLS-terminating proxy", () => {
    // tailscale serve / nginx: browser on https, upstream request is http.
    expect(
      browserOriginFromRequest(
        req("http://mac-mini.tail5665af.ts.net:47130/acme/policies", {
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://mac-mini.tail5665af.ts.net:47130");
  });

  it("honors X-Forwarded-Host when the proxy rewrites the host", () => {
    expect(
      browserOriginFromRequest(
        req("http://127.0.0.1:8080/", {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "executor.sh",
        }),
      ),
    ).toBe("https://executor.sh");
  });

  it("takes the first value of a comma-listed forwarded chain", () => {
    expect(
      browserOriginFromRequest(
        req("http://internal:8080/", {
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "executor.sh, internal",
        }),
      ),
    ).toBe("https://executor.sh");
  });

  it("falls back to the request scheme/host for the half-set header", () => {
    // Only proto forwarded: keep the request's own host.
    expect(
      browserOriginFromRequest(req("http://localhost:43130/", { "x-forwarded-proto": "https" })),
    ).toBe("https://localhost:43130");
    // Only host forwarded: keep the request's own scheme.
    expect(
      browserOriginFromRequest(
        req("http://localhost:43130/", { "x-forwarded-host": "executor.sh" }),
      ),
    ).toBe("http://executor.sh");
  });
});
