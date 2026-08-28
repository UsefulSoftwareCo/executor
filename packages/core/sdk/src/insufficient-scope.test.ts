import { describe, expect, it } from "@effect/vitest";

import { authToolFailure } from "./auth-tool-failure";
import { detectInsufficientScope } from "./insufficient-scope";

describe("detectInsufficientScope", () => {
  it("detects Google's ErrorInfo reason nested in an error body", () => {
    const body = {
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            domain: "googleapis.com",
            metadata: { service: "drive.googleapis.com" },
          },
        ],
      },
    };
    expect(detectInsufficientScope({ body })).toEqual({ requiredScopes: [] });
  });

  it("detects the RFC 6750 error body", () => {
    expect(detectInsufficientScope({ body: { error: "insufficient_scope" } })).toEqual({
      requiredScopes: [],
    });
  });

  it("reads required scopes from a WWW-Authenticate challenge", () => {
    expect(
      detectInsufficientScope({
        body: null,
        headers: {
          "www-authenticate":
            'Bearer realm="example", error="insufficient_scope", scope="files.read files.meta"',
        },
      }),
    ).toEqual({ requiredScopes: ["files.read", "files.meta"] });
  });

  it("detects the signal inside a JSON text body", () => {
    expect(detectInsufficientScope({ body: '{"error":"insufficient_scope"}' })).toEqual({
      requiredScopes: [],
    });
  });

  it("never classifies non-JSON text, even when it embeds example JSON", () => {
    expect(
      detectInsufficientScope({
        body: "Proxy note: error=insufficient_scope was returned upstream",
      }),
    ).toBeNull();
    expect(
      detectInsufficientScope({
        body: 'The docs show {"error":"insufficient_scope"} as an example response',
      }),
    ).toBeNull();
  });

  it("ignores quoted challenge parameter values that embed the error token", () => {
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate":
            'Bearer error_description="Example: error=insufficient_scope for missing grants"',
        },
      }),
    ).toBeNull();
  });

  it("ignores prose that merely mentions the tokens", () => {
    expect(
      detectInsufficientScope({
        body: {
          error: {
            message:
              "If the token lacks access you may see insufficient_scope or ACCESS_TOKEN_SCOPE_INSUFFICIENT in provider docs",
          },
        },
      }),
    ).toBeNull();
    expect(
      detectInsufficientScope({
        body: "Consult the OAuth guide about insufficient_scope errors",
      }),
    ).toBeNull();
  });

  it("ignores the tokens under other field names and inside data lists", () => {
    expect(
      detectInsufficientScope({
        body: { supportedErrors: ["invalid_token", "insufficient_scope"] },
      }),
    ).toBeNull();
    expect(detectInsufficientScope({ body: { code: "insufficient_scope" } })).toBeNull();
  });

  it("ignores look-alike challenge parameters and values", () => {
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": 'Bearer x-error="insufficient_scope"' },
      }),
    ).toBeNull();
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": 'Bearer error="insufficient_scope_extra"' },
      }),
    ).toBeNull();
  });

  it("consumes quoted-pairs, so an escaped quote cannot fabricate a parameter", () => {
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": 'Bearer error_description="Example: \\"error=insufficient_scope"',
        },
      }),
    ).toBeNull();
  });

  it("never discovers a scheme inside another challenge's quoted value", () => {
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate":
            'Basic error_description="Proxy saw Bearer error=insufficient_scope upstream"',
        },
      }),
    ).toBeNull();
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate":
            'Digest realm="x", qop="auth Bearer error=insufficient_scope", nonce="n"',
        },
      }),
    ).toBeNull();
    // A Basic challenge followed by a harmless real Bearer challenge: the
    // Bearer params are read, and they do not include the Basic params.
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": 'Basic error=insufficient_scope, Bearer realm="api"',
        },
      }),
    ).toBeNull();
  });

  it("only reads the Bearer scheme's parameters", () => {
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": 'Basic realm="example", error=insufficient_scope' },
      }),
    ).toBeNull();
    // Multi-challenge: params after the NEXT scheme are not Bearer's.
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": 'Bearer realm="api", Basic error=insufficient_scope',
        },
      }),
    ).toBeNull();
  });

  it("evaluates repeated Bearer challenges independently", () => {
    // The second Bearer challenge carries the signal; the first must not
    // shadow it (params are per challenge, not first-wins across the header).
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate":
            "Bearer error=invalid_token, Basic realm=x, Bearer error=insufficient_scope",
        },
      }),
    ).toEqual({ requiredScopes: [] });
    // And a scope attr from an unrelated Bearer challenge does not leak into
    // the one that matched.
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": 'Bearer scope="other.scope", Bearer error=insufficient_scope',
        },
      }),
    ).toEqual({ requiredScopes: [] });
  });

  it("recognizes a new scheme only at a comma boundary", () => {
    // Comma-less run-ons are malformed and must not fabricate a Bearer
    // challenge out of a bare word.
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": "Basic realm=x Bearer error=insufficient_scope" },
      }),
    ).toBeNull();
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": "Basic error_description=Proxy Bearer error=insufficient_scope",
        },
      }),
    ).toBeNull();
  });

  it("steps over a token68 blob to a later legitimate Bearer challenge", () => {
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": "Negotiate abc/def==, Bearer error=insufficient_scope",
        },
      }),
    ).toEqual({ requiredScopes: [] });
  });

  it("never classifies malformed headers", () => {
    // Unterminated quoted-string.
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": 'Bearer error="insufficient_scope' },
      }),
    ).toBeNull();
    // Quoted value run into the next token with no separator.
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": 'Basic realm="x"Bearer error=insufficient_scope' },
      }),
    ).toBeNull();
  });

  it("accepts BWS around the auth-param equals sign", () => {
    for (const header of [
      "Bearer error =insufficient_scope",
      "Bearer error= insufficient_scope",
      'Bearer error = "insufficient_scope"',
    ]) {
      expect(detectInsufficientScope({ headers: { "www-authenticate": header } })).toEqual({
        requiredScopes: [],
      });
    }
  });

  it("rejects params attached to token68 or scheme-only challenges", () => {
    for (const header of [
      "Bearer a=, error=insufficient_scope",
      "Bearer abc, error=insufficient_scope",
      "Bearer, error=insufficient_scope",
      'Bearer realm="x" error=insufficient_scope',
    ]) {
      expect(
        detectInsufficientScope({ headers: { "www-authenticate": header } }),
        header,
      ).toBeNull();
    }
  });

  it("accepts full HTTP token characters in schemes and param names", () => {
    for (const header of [
      "Bearer foo!=bar, error=insufficient_scope",
      "Bearer x#=bar, error=insufficient_scope",
      "Bearer x|=bar, error=insufficient_scope",
      "Foo! realm=x, Bearer error=insufficient_scope",
    ]) {
      expect(detectInsufficientScope({ headers: { "www-authenticate": header } }), header).toEqual({
        requiredScopes: [],
      });
    }
  });

  it("rejects empty values, non-token values, and duplicate param names", () => {
    for (const header of [
      "Bearer realm =, error=insufficient_scope",
      "Bearer realm=;, error=insufficient_scope",
      "Bearer error=insufficient_scope, error=invalid_token",
      // `/` and `=` are token68-only; schemes, param names, and unquoted
      // values are HTTP tokens.
      "Bearer foo/bar=baz, error=insufficient_scope",
      "Foo/Bar realm=x, Bearer error=insufficient_scope",
      "Bearer realm=foo/bar, error=insufficient_scope",
      "Bearer realm=foo=bar, error=insufficient_scope",
      // `!` is token-only, not token68.
      "Bearer abc!==, error=insufficient_scope",
    ]) {
      expect(
        detectInsufficientScope({ headers: { "www-authenticate": header } }),
        header,
      ).toBeNull();
    }
  });

  it("tolerates real-provider header quirks without weakening the signal params", () => {
    // Stripe (live snapshot): unquoted resource_metadata URL.
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate":
            "Bearer resource_metadata=https://mcp.stripe.com/.well-known/oauth-protected-resource, error=insufficient_scope",
        },
      }),
    ).toEqual({ requiredScopes: [] });
    // Sentry (live snapshot): duplicated resource_metadata param.
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate":
            'Bearer realm="OAuth", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource", error="insufficient_scope", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource"',
        },
      }),
    ).toEqual({ requiredScopes: [] });
    // But a duplicated SIGNAL param still fails closed.
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": "Bearer error=insufficient_scope, error=invalid_token",
        },
      }),
    ).toBeNull();
  });

  it("accepts comma-separated params within one Bearer challenge", () => {
    expect(
      detectInsufficientScope({
        headers: {
          "www-authenticate": 'Bearer realm="api", error="insufficient_scope", scope="a.b"',
        },
      }),
    ).toEqual({ requiredScopes: ["a.b"] });
  });

  it("accepts an unquoted RFC 6750 challenge value", () => {
    expect(
      detectInsufficientScope({
        headers: { "www-authenticate": "Bearer error=insufficient_scope" },
      }),
    ).toEqual({ requiredScopes: [] });
  });

  it("returns null for an ordinary 403 body", () => {
    expect(
      detectInsufficientScope({
        body: { error: { status: "PERMISSION_DENIED", message: "Caller lacks permission" } },
        headers: { "www-authenticate": 'Bearer realm="example", error="invalid_token"' },
      }),
    ).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectInsufficientScope({})).toBeNull();
  });
});

describe("authToolFailure recovery for oauth_scope_insufficient", () => {
  const recoveryOf = (result: ReturnType<typeof authToolFailure>) => {
    const details = (result as { error: { details: { recovery: Record<string, string> } } }).error
      .details;
    return details.recovery;
  };

  it("omits the oauth.start hint, which would re-run the identical grant", () => {
    const recovery = recoveryOf(
      authToolFailure({ code: "oauth_scope_insufficient", message: "scope shortfall" }),
    );
    expect(recovery.startOAuthTool).toBeUndefined();
    expect(recovery.oauthInstructions).toBeUndefined();
    expect(recovery.scopeInstructions).toContain("does not cover the scope");
    expect(recovery.listConnectionsTool).toBe("executor.coreTools.connections.list");
  });

  it("keeps the full recovery block for connection_rejected", () => {
    const recovery = recoveryOf(
      authToolFailure({ code: "connection_rejected", message: "rejected" }),
    );
    expect(recovery.startOAuthTool).toBe("executor.coreTools.oauth.start");
    expect(recovery.oauthInstructions).toBeDefined();
  });
});
