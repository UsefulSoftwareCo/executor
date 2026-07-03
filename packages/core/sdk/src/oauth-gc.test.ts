import { describe, expect, test } from "@effect/vitest";

import {
  classifyOAuthClientGc,
  isDcrClassifiedRow,
  registrableOriginOfUrl,
  type OAuthClientGcRow,
} from "./oauth-gc";

// The GC decision matrix (issue #1120, Part C). These lock the conjunctive,
// fail-safe deletion predicate the local libSQL migration and the cloud code
// migration both encode: delete ⇔ classified-DCR AND zero referencing
// connections. Everything else is kept.

const explicitDcr: OAuthClientGcRow = {
  grant: "authorization_code",
  resource: "https://cloudflare.example/mcp",
  origin_kind: "dynamic_client_registration",
};

const legacyDcr: OAuthClientGcRow = {
  // Pre-Part-A row: null origin_kind, auth-code grant, carries a resource.
  grant: "authorization_code",
  resource: "https://cloudflare.example/mcp",
  origin_kind: null,
};

const manual: OAuthClientGcRow = {
  grant: "authorization_code",
  resource: null,
  origin_kind: "manual",
};

describe("isDcrClassifiedRow", () => {
  test("classifies an explicit-origin DCR row as DCR", () => {
    expect(isDcrClassifiedRow(explicitDcr)).toBe(true);
  });

  test("classifies a legacy null-origin auth-code row with a resource as DCR", () => {
    // The resource parameter (RFC 8707) is only ever set by the DCR/MCP connect
    // path, so an auth-code legacy row carrying one is a DCR client.
    expect(isDcrClassifiedRow(legacyDcr)).toBe(true);
    // The prod-shaped case the old `…mcp…` slug regex misclassified as manual:
    // a bare provider-name slug (`cloudflare`) with an MCP resource. The slug no
    // longer participates in classification; the resource alone makes it DCR.
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: "https://mcp.cloudflare.com/mcp",
        origin_kind: null,
      }),
    ).toBe(true);
    // Other bare-slug providers the old regex missed (linear, notion): their
    // MCP resources classify them as DCR regardless of slug.
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: "https://mcp.linear.app/mcp",
        origin_kind: null,
      }),
    ).toBe(true);
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: "https://mcp.notion.com/mcp",
        origin_kind: null,
      }),
    ).toBe(true);
  });

  test("an explicit manual stamp wins even when the row carries a resource", () => {
    expect(isDcrClassifiedRow(manual)).toBe(false);
    // Stamped-manual BYO row WITH a resource: the stamp wins, stays manual.
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: "https://cloudflare.example/mcp",
        origin_kind: "manual",
      }),
    ).toBe(false);
  });

  test("an explicit DCR stamp wins even with no resource", () => {
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: null,
        origin_kind: "dynamic_client_registration",
      }),
    ).toBe(true);
  });

  test("a legacy null-origin row with no resource is NOT DCR (ambiguous stays manual)", () => {
    // No resource: a hand-registered app never sets one, so this is manual.
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: null,
        origin_kind: null,
      }),
    ).toBe(false);
    // Empty-string resource is treated the same as null.
    expect(
      isDcrClassifiedRow({
        grant: "authorization_code",
        resource: "",
        origin_kind: null,
      }),
    ).toBe(false);
  });

  test("a legacy client_credentials row with a resource is NOT DCR", () => {
    // Only the auth-code grant path mints DCR clients; client_credentials with a
    // resource is a manual BYO app.
    expect(
      isDcrClassifiedRow({
        grant: "client_credentials",
        resource: "https://cloudflare.example/mcp",
        origin_kind: null,
      }),
    ).toBe(false);
  });
});

describe("classifyOAuthClientGc decision matrix", () => {
  test("DCR + orphaned (zero connections) → delete", () => {
    expect(classifyOAuthClientGc(explicitDcr, 0)).toEqual({
      action: "delete",
      reason: "dcr-orphaned",
    });
    expect(classifyOAuthClientGc(legacyDcr, 0)).toEqual({
      action: "delete",
      reason: "dcr-orphaned",
    });
  });

  test("DCR + referenced (>=1 connection) → keep", () => {
    expect(classifyOAuthClientGc(explicitDcr, 1)).toEqual({
      action: "keep",
      reason: "referenced",
    });
    expect(classifyOAuthClientGc(legacyDcr, 3)).toEqual({
      action: "keep",
      reason: "referenced",
    });
  });

  test("manual + orphaned → keep (a hand-registered app is never GC'd)", () => {
    expect(classifyOAuthClientGc(manual, 0)).toEqual({ action: "keep", reason: "not-dcr" });
  });

  test("manual + referenced → keep", () => {
    expect(classifyOAuthClientGc(manual, 5)).toEqual({ action: "keep", reason: "not-dcr" });
  });

  test("legacy resource-classified DCR is treated exactly like an explicit DCR row", () => {
    // Same (row-shape, count) inputs produce the same decision whether the DCR
    // classification came from origin_kind or the resource heuristic.
    expect(classifyOAuthClientGc(legacyDcr, 0).action).toBe(
      classifyOAuthClientGc(explicitDcr, 0).action,
    );
    expect(classifyOAuthClientGc(legacyDcr, 2).action).toBe(
      classifyOAuthClientGc(explicitDcr, 2).action,
    );
  });

  test("idempotency: once a DCR row is referenced (kept), a re-run keeps it (never deletes)", () => {
    // A second GC pass sees the same referenced DCR rows and the same manual
    // rows; none flip to delete. (Orphaned DCR rows are gone after pass 1, so
    // the only rows a second pass sees are keeps.)
    for (const count of [1, 2, 10]) {
      expect(classifyOAuthClientGc(explicitDcr, count).action).toBe("keep");
      expect(classifyOAuthClientGc(legacyDcr, count).action).toBe("keep");
    }
    expect(classifyOAuthClientGc(manual, 0).action).toBe("keep");
  });
});

describe("registrableOriginOfUrl (issuer backfill value)", () => {
  test("collapses a subdomain token host to its registrable origin", () => {
    expect(registrableOriginOfUrl("https://oauth.cloudflare.com/token")).toBe(
      "https://cloudflare.com",
    );
    expect(registrableOriginOfUrl("https://login.microsoftonline.com/common/oauth2/token")).toBe(
      "https://microsoftonline.com",
    );
  });

  test("keeps an already-registrable host as-is", () => {
    expect(registrableOriginOfUrl("https://github.com/login/oauth/access_token")).toBe(
      "https://github.com",
    );
  });

  test("respects multi-label public suffixes via the full PSL", () => {
    expect(registrableOriginOfUrl("https://api.foo.co.uk/token")).toBe("https://foo.co.uk");
    // Suffixes the old hardcoded 12-entry list missed: .co.in, .com.cn, .co.za.
    // `accounts.example.co.in` must collapse to `example.co.in`, not `co.in`.
    expect(registrableOriginOfUrl("https://accounts.example.co.in/token")).toBe(
      "https://example.co.in",
    );
    expect(registrableOriginOfUrl("https://oauth.example.com.cn/token")).toBe(
      "https://example.com.cn",
    );
    expect(registrableOriginOfUrl("https://login.example.co.za/token")).toBe(
      "https://example.co.za",
    );
  });

  test("preserves scheme and port for loopback / dev token hosts", () => {
    expect(registrableOriginOfUrl("http://127.0.0.1:8787/token")).toBe("http://127.0.0.1:8787");
    expect(registrableOriginOfUrl("http://localhost:4788/oauth/token")).toBe(
      "http://localhost:4788",
    );
  });

  test("returns null for a non-URL token value", () => {
    expect(registrableOriginOfUrl("not a url")).toBeNull();
    expect(registrableOriginOfUrl("")).toBeNull();
  });
});
