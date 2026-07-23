// Identity ranking heuristics: what leads in a rendered response, and which
// candidate call gets pre-seeded, are product behavior: email beats login
// beats display name beats id, and only singular paths make a call a whoami.
import { describe, expect, it } from "@effect/vitest";

import {
  candidateIdentityTier,
  classifyHttpStatus,
  classifyProbeResponse,
  rankResponseSample,
  sortHealthCheckCandidatesByIdentity,
} from "./health-check";

const row = (path: string, value: string) => ({ path, value });

describe("rankResponseSample", () => {
  it("puts identity fields first (email before login), rest in response order", () => {
    const ranked = rankResponseSample([
      row("createdAt", "2024-01-01"),
      row("login", "alice"),
      row("plan", "pro"),
      row("email", "alice@example.com"),
    ]);
    expect(ranked.map((r) => r.path)).toEqual(["email", "login", "createdAt", "plan"]);
  });

  it("is stable within a tier and for non-identity rows", () => {
    const ranked = rankResponseSample([
      row("a", "1"),
      row("b", "2"),
      row("user.email", "x@y.z"),
      row("account.email", "a@b.c"),
    ]);
    // Both emails are tier 0; original order preserved between them, and the
    // non-identity rows keep their relative order after.
    expect(ranked.map((r) => r.path)).toEqual(["user.email", "account.email", "a", "b"]);
  });
});

describe("candidateIdentityTier", () => {
  it("ignores identity keys under array segments (a collection's members, not the caller)", () => {
    const listAliases = {
      operation: "aliases.listAliases",
      method: "get",
      requiredArgCount: 0,
      destructive: false,
      responseFields: [
        { path: "aliases.0.creator.email", type: "string" },
        { path: "aliases.0.uid", type: "string" },
        { path: "pagination.count", type: "number" },
      ],
    };
    const getAuthUser = {
      operation: "user.getAuthUser",
      method: "get",
      requiredArgCount: 0,
      destructive: false,
      responseFields: [
        { path: "user.email", type: "string" },
        { path: "user.id", type: "string" },
      ],
    };
    expect(candidateIdentityTier(listAliases), "array-nested email does not count").toBe(-1);
    expect(candidateIdentityTier(getAuthUser), "singular email counts").toBe(0);
    expect(
      sortHealthCheckCandidatesByIdentity([listAliases, getAuthUser])[0]?.operation,
      "the whoami call ranks ahead of the list",
    ).toBe("user.getAuthUser");
  });
});

// Probe classification: 401/403 mean "credential dead" EXCEPT the
// configuration 403 (Google accessNotConfigured / SERVICE_DISABLED), which
// must read misconfigured: the token authenticated, the API is disabled in
// the OAuth client's project, and reconnecting cannot fix it. This is the
// production case behind the "Expired when it is not" report (2026-07-10).
describe("classifyProbeResponse", () => {
  const disabledMessage =
    "Gmail API has not been used in project 000000000000 before or it is disabled. " +
    "Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=000000000000 then retry.";

  it("classifies Google's classic accessNotConfigured 403 as misconfigured", () => {
    const body = {
      error: {
        code: 403,
        message: disabledMessage,
        errors: [
          { message: disabledMessage, domain: "usageLimits", reason: "accessNotConfigured" },
        ],
        status: "PERMISSION_DENIED",
      },
    };
    expect(classifyProbeResponse(403, body)).toBe("misconfigured");
  });

  it("classifies the newer SERVICE_DISABLED ErrorInfo detail as misconfigured", () => {
    const body = {
      error: {
        code: 403,
        message: disabledMessage,
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            domain: "googleapis.com",
          },
        ],
      },
    };
    expect(classifyProbeResponse(403, body)).toBe("misconfigured");
  });

  it("keeps a plain 403 (no recognized reason) as expired: false-expired is the safe default", () => {
    expect(classifyProbeResponse(403, { error: { code: 403, message: "Forbidden" } })).toBe(
      "expired",
    );
    expect(classifyProbeResponse(403, undefined)).toBe("expired");
    expect(classifyProbeResponse(403, "Forbidden")).toBe("expired");
    // A permission reason that is NOT a configuration marker stays expired.
    expect(
      classifyProbeResponse(403, {
        error: { errors: [{ reason: "insufficientPermissions" }] },
      }),
    ).toBe("expired");
  });

  it("never rewrites a 401: an authentication failure is a credential problem regardless of body", () => {
    const body = { error: { errors: [{ reason: "accessNotConfigured" }] } };
    expect(classifyProbeResponse(401, body)).toBe("expired");
  });

  it("matches the status-only classifier everywhere else", () => {
    for (const status of [200, 204, 404, 429, 500, 503]) {
      expect(classifyProbeResponse(status, { error: {} }), `status ${status}`).toBe(
        classifyHttpStatus(status),
      );
    }
  });
});
