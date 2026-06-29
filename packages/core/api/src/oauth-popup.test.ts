// ---------------------------------------------------------------------------
// Fidelity tests for the OAuth popup HTML generator + callback wrapper.
// Locks in the escaping rules, postMessage/BroadcastChannel behavior, and
// the completeOAuth-to-popup-payload conversion semantics so the google-
// discovery port is provably behavior-preserving.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";

import {
  OAUTH_POPUP_MESSAGE_TYPE,
  popupDocument,
  runOAuthCallback,
  type OAuthPopupResult,
} from "./oauth-popup";

type GoogleAuth = {
  kind: "oauth2";
  accessTokenSecretId: string;
  refreshTokenSecretId: string | null;
};

const DomainErrorShape = Schema.Struct({
  _tag: Schema.Literal("DomainError"),
  message: Schema.String,
});
const isDomainError = Schema.is(DomainErrorShape);

// ---------------------------------------------------------------------------
// popupDocument
// ---------------------------------------------------------------------------

describe("popupDocument", () => {
  const successPayload: OAuthPopupResult<GoogleAuth> = {
    type: OAUTH_POPUP_MESSAGE_TYPE,
    ok: true,
    sessionId: "session-abc",
    kind: "oauth2",
    accessTokenSecretId: "secret_1",
    refreshTokenSecretId: "secret_2",
  };

  it("renders a success page with Connected title and the green check icon", () => {
    const html = popupDocument(successPayload, "channel-x");
    expect(html).toContain("<title>Connected</title>");
    expect(html).toContain("#22c55e");
    expect(html).toContain("Authentication complete");
  });

  it("renders a failure page with the error text escaped", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "Token endpoint returned 400 <script>alert(1)</script>",
      },
      "channel-x",
    );
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("#ef4444");
    expect(html).toContain("Token endpoint returned 400 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("renders a collapsible details disclosure when errorDetails is present", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "Could not complete authentication",
        errorDetails: "HTTP 201 Created from https://api.supabase.com/v1/oauth/token",
      },
      "channel-x",
    );
    expect(html).toContain("Could not complete authentication");
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Details</summary>");
    expect(html).toContain("HTTP 201 Created from https://api.supabase.com/v1/oauth/token");
  });

  it("escapes HTML inside errorDetails", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "Failed",
        errorDetails: "<script>alert('xss')</script>",
      },
      "channel-x",
    );
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    // Ensure the raw script tag does not appear inside the rendered <pre>.
    const preMatch = /<pre[^>]*>([^<]*)<\/pre>/.exec(html);
    expect(preMatch).not.toBeNull();
    expect(preMatch![1]).not.toContain("<script>");
  });

  it("omits the details disclosure when errorDetails matches error", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "Failed",
        errorDetails: "Failed",
      },
      "channel-x",
    );
    expect(html).not.toContain("<details");
  });

  it("HTML-escapes the BroadcastChannel name so attacker-controlled names cannot break out", () => {
    const html = popupDocument(successPayload, 'evil"name');
    expect(html).toContain('new BroadcastChannel("evil&quot;name")');
  });

  it("escapes < > & in the serialized script payload to prevent </script> breakout", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "</script><img/src=x onerror=alert(1)>",
      },
      "channel-x",
    );
    // The raw `</script>` must not appear in the inline script literal.
    const scriptLiteralMatch = /const p=(\{.*?\});/.exec(html);
    expect(scriptLiteralMatch).not.toBeNull();
    const scriptLiteral = scriptLiteralMatch![1]!;
    expect(scriptLiteral).not.toContain("</script>");
    expect(scriptLiteral).toContain("\\u003c/script\\u003e");
  });

  it("posts to window.opener AND falls back to BroadcastChannel with the given channel name", () => {
    const html = popupDocument(successPayload, "executor:openapi-oauth-result");
    expect(html).toContain("window.opener.postMessage(p,window.location.origin)");
    expect(html).toContain('new BroadcastChannel("executor:openapi-oauth-result")');
    expect(html).toContain("window.close()");
  });

  it("includes dark-mode CSS", () => {
    const html = popupDocument(successPayload, "c");
    expect(html).toContain("@media(prefers-color-scheme:dark)");
  });
});

// ---------------------------------------------------------------------------
// runOAuthCallback
// ---------------------------------------------------------------------------

describe("runOAuthCallback", () => {
  it("renders a success popup when completeOAuth succeeds", async () => {
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete: () =>
          Effect.succeed({
            kind: "oauth2",
            accessTokenSecretId: "s1",
            refreshTokenSecretId: "s2",
          }),
        urlParams: { state: "session-xyz", code: "abc" },
        toErrorMessage: () => ({ short: "should not reach" }),
        channelName: "channel-x",
      }),
    );
    expect(html).toContain("<title>Connected</title>");
    expect(html).toContain("session-xyz");
    expect(html).toContain("s1");
  });

  it("passes code, error, and the regional domain through to the complete callback", async () => {
    const received: Array<{
      state: string;
      code: string | null;
      error: string | null;
      callbackDomain: string | null;
    }> = [];
    await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete: (params) => {
          received.push(params);
          return Effect.succeed({
            kind: "oauth2",
            accessTokenSecretId: "s",
            refreshTokenSecretId: null,
          });
        },
        // Multi-site providers (Datadog) echo the org's region back as `domain`,
        // which `runOAuthCallback` surfaces as `callbackDomain`.
        urlParams: { state: "s1", code: "code1", error: null, domain: "us5.datadoghq.com" },
        toErrorMessage: () => ({ short: "" }),
        channelName: "c",
      }),
    );
    expect(received).toEqual([
      { state: "s1", code: "code1", error: null, callbackDomain: "us5.datadoghq.com" },
    ]);
  });

  it("falls back to `site` for the regional domain and defaults to null", async () => {
    const received: Array<{ callbackDomain: string | null }> = [];
    const complete = (params: { callbackDomain: string | null }) => {
      received.push(params);
      return Effect.succeed({
        kind: "oauth2" as const,
        accessTokenSecretId: "s",
        refreshTokenSecretId: null,
      });
    };
    // `site` is the full-origin variant; used only when `domain` is absent.
    await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete,
        urlParams: { state: "s1", code: "c", site: "https://eu1.datadoghq.com" },
        toErrorMessage: () => ({ short: "" }),
        channelName: "c",
      }),
    );
    // No region hints at all -> null (standard single-site providers).
    await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete,
        urlParams: { state: "s2", code: "c" },
        toErrorMessage: () => ({ short: "" }),
        channelName: "c",
      }),
    );
    expect(received[0]!.callbackDomain).toBe("https://eu1.datadoghq.com");
    expect(received[1]!.callbackDomain).toBeNull();
  });

  it("renders provider OAuth errors without invoking completeOAuth", async () => {
    let completeCalls = 0;
    const complete = () => {
      completeCalls += 1;
      return Effect.succeed({
        kind: "oauth2" as const,
        accessTokenSecretId: "s",
        refreshTokenSecretId: null,
      });
    };
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete,
        urlParams: {
          state: "s1",
          error: "invalid_scope",
          error_description: "unknown scope wizard_session:write",
        },
        toErrorMessage: () => ({ short: "" }),
        channelName: "c",
      }),
    );
    expect(completeCalls).toBe(0);
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("OAuth provider rejected authorization");
    expect(html).toContain("invalid_scope");
    expect(html).toContain("unknown scope wizard_session:write");
  });

  it("renders a failure popup when completeOAuth fails and uses toErrorMessage", async () => {
    class DomainError extends Data.TaggedError("DomainError")<{
      readonly message: string;
    }> {}
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, DomainError, never>({
        complete: () => Effect.fail(new DomainError({ message: "Code expired" })),
        urlParams: { state: "s1" },
        toErrorMessage: (error) => {
          if (!isDomainError(error)) return { short: "unknown" };
          // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: schema guard narrows the unknown popup callback error to the public test message
          return { short: "Auth failed", details: error.message };
        },
        channelName: "c",
      }),
    );
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("Auth failed");
    expect(html).toContain("<summary");
    expect(html).toContain("Code expired");
  });

  it("omits the details disclosure when details match the short message", async () => {
    class DomainError extends Data.TaggedError("DomainError")<{
      readonly message: string;
    }> {}
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, DomainError, never>({
        complete: () => Effect.fail(new DomainError({ message: "boom" })),
        urlParams: { state: "s1" },
        toErrorMessage: () => ({ short: "Same", details: "Same" }),
        channelName: "c",
      }),
    );
    expect(html).toContain("Same");
    expect(html).not.toContain("<details");
  });

  it("never rejects — even defects are rendered as a failure popup", async () => {
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete: () => Effect.die("boom"),
        urlParams: { state: "s1" },
        toErrorMessage: () => ({ short: "transport error" }),
        channelName: "c",
      }),
    );
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("transport error");
  });
});
