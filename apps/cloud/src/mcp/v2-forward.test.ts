import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";

import {
  FORWARD_TOKEN_TTL_SECONDS,
  TOOLKIT_NOT_FOUND_MESSAGE,
  buildV2Url,
  forwardHeaders,
  forwardToV2,
  mintForwardToken,
  relayV2Response,
  toolkitConnectionId,
  type V2ForwardDeps,
  type V2ForwardEnv,
} from "./v2-forward";

const SECRET = "test-secret-0123456789abcdef0123456789";
const V2_ORG = "00000000-0000-4000-8000-000000000001";
const ORIGIN = "https://mcp.example.test";
const NOW = 1_900_000_000;

const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const decodePayload = (token: string): Record<string, unknown> => {
  const payload = token.split(".")[1] ?? "";
  return decodeJson(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
};

class SimulatedOutage extends Data.TaggedError("SimulatedOutage")<{}> {}

/** A promise that rejects the way a failing service binding or database does. */
const outage = (): Promise<never> => Effect.runPromise(Effect.fail(new SimulatedOutage()));

const principal = { accountId: "user_EXAMPLE", organizationId: "org_EXAMPLE" } as const;
const moved = { v2OrganizationId: V2_ORG } as const;

const API_KEY = "sk_test_synthetic_key_value";
// Computed independently of the code under test: unpadded base64url SHA-256.
const API_KEY_HASH = createHash("sha256").update(API_KEY).digest("base64url");

// An API-key caller whose key belongs to a different organization than the one
// the URL selects: the forwarded `organization` stays the selected one.
const apiKeyPrincipal = {
  ...principal,
  apiKey: { id: "api_key_EXAMPLE", organizationId: "org_KEY_OWNER", hash: API_KEY_HASH },
} as const;

/** True when `token`'s signature is HMAC-SHA256 over "v1fwd." + payload under `secret`. */
const signatureVerifies = (token: string, secret: string): boolean => {
  const [prefix, payload, signature] = token.split(".");
  return (
    createHmac("sha256", secret).update(`${prefix}.${payload}`).digest("base64url") === signature
  );
};

const rawPayload = (token: string): string => {
  const payload = token.split(".")[1] ?? "";
  return Buffer.from(payload, "base64url").toString("utf8");
};

const makeEnv = (respond: (request: Request) => Response | Promise<Response>) => {
  const seen: Request[] = [];
  const env: V2ForwardEnv = {
    V2_MCP: {
      fetch: (request) => {
        seen.push(request);
        return Promise.resolve(respond(request));
      },
    },
    V2_MCP_ORIGIN: ORIGIN,
    V2_MCP_FORWARD_SECRET: SECRET,
  };
  return { env, seen };
};

const makeDeps = (rows: Record<string, string> = {}): V2ForwardDeps => ({
  resolveToolkitRowId: (_org, _account, slug) => Promise.resolve(rows[slug] ?? null),
  nowSeconds: () => NOW,
  log: () => undefined,
});

describe("forward token", () => {
  it("matches the wire-contract test vector", async () => {
    const token = await mintForwardToken(SECRET, {
      account: "user_EXAMPLE",
      organization: "org_EXAMPLE",
      exp: 2000000000,
    });
    expect(token).toBe(
      "v1fwd.eyJ2IjoxLCJhY2NvdW50IjoidXNlcl9FWEFNUExFIiwib3JnYW5pemF0aW9uIjoib3JnX0VYQU1QTEUiLCJleHAiOjIwMDAwMDAwMDB9.bC5em3xeD9AGJD2Gj8DCzzAu6gTKd3rnelfBCSL0-Dg",
    );
  });

  it("names the toolkit and its connection for a toolkit URL", async () => {
    const token = await mintForwardToken(SECRET, {
      account: "user_EXAMPLE",
      organization: "org_EXAMPLE",
      exp: 2000000000,
      toolkit: { id: "tk_row_example", connection: "v1-abc" },
    });
    expect(decodePayload(token)).toEqual({
      v: 1,
      account: "user_EXAMPLE",
      organization: "org_EXAMPLE",
      exp: 2000000000,
      toolkit: "tk_row_example",
      connection: "v1-abc",
    });
  });

  it("puts the API key last, after the toolkit, and still signs the payload", async () => {
    const token = await mintForwardToken(SECRET, {
      account: "user_EXAMPLE",
      organization: "org_EXAMPLE",
      exp: 2000000000,
      toolkit: { id: "tk_row_example", connection: "v1-abc" },
      apiKey: { id: "api_key_EXAMPLE", organization: "org_KEY_OWNER", hash: API_KEY_HASH },
    });
    expect(rawPayload(token)).toBe(
      JSON.stringify({
        v: 1,
        account: "user_EXAMPLE",
        organization: "org_EXAMPLE",
        exp: 2000000000,
        toolkit: "tk_row_example",
        connection: "v1-abc",
        apiKey: { id: "api_key_EXAMPLE", organization: "org_KEY_OWNER", hash: API_KEY_HASH },
      }),
    );
    expect(signatureVerifies(token, SECRET)).toBe(true);
  });
});

describe("toolkit connection id", () => {
  // `v1-` + the first 40 hex chars of SHA-256 over
  // JSON.stringify([v2OrganizationId, toolkitRowId, accountId]).
  it("matches the wire-contract test vector", async () => {
    expect(await toolkitConnectionId(V2_ORG, "tk_row_example", "user_EXAMPLE")).toBe(
      "v1-59b67fa9ffe6d72010b3b9fa56f5bdb38199f2e1",
    );
  });

  it("names one connection per member of the toolkit", async () => {
    const mine = await toolkitConnectionId(V2_ORG, "tk_row_example", "user_EXAMPLE");
    const theirs = await toolkitConnectionId(V2_ORG, "tk_row_example", "user_OTHER");
    expect(theirs).toBe("v1-7bb309a1759624b5a62f0d3a3601e3bbc48af0e9");
    expect(theirs).not.toBe(mine);
    expect(await toolkitConnectionId(V2_ORG, "tk_row_example", "user_EXAMPLE")).toBe(mine);
  });
});

describe("v2 URL", () => {
  const url = (query: string, connection?: string) =>
    buildV2Url(ORIGIN, new Request(`https://executor.sh/mcp${query}`), connection).href;

  it("targets /mcp with no query by default", () => {
    expect(url("")).toBe(`${ORIGIN}/mcp`);
  });

  it("carries a non-default elicitation mode only", () => {
    expect(url("?elicitation_mode=native")).toBe(`${ORIGIN}/mcp?elicitation_mode=native`);
    expect(url("?elicitation_mode=browser")).toBe(`${ORIGIN}/mcp?elicitation_mode=browser`);
    expect(url("?elicitation_mode=model")).toBe(`${ORIGIN}/mcp`);
    expect(url("?elicitation_mode=bogus")).toBe(`${ORIGIN}/mcp`);
  });

  it("drops every other v1 parameter", () => {
    expect(url("?search_tools=true&artifacts=false&mode=codemode&x=1")).toBe(`${ORIGIN}/mcp`);
    expect(url("?mode=passthrough")).toBe(`${ORIGIN}/mcp`);
  });

  it("adds the connection for a toolkit URL", () => {
    expect(url("?elicitation_mode=native", "v1-abc")).toBe(
      `${ORIGIN}/mcp?elicitation_mode=native&connection=v1-abc`,
    );
  });
});

describe("forwarded headers", () => {
  it("replaces credentials and drops v1 routing and internal headers", () => {
    const headers = forwardHeaders(
      new Headers({
        authorization: "Bearer client-token",
        cookie: "session=1",
        origin: "https://client.example",
        host: "executor.sh",
        "x-executor-mcp-organization": "acme",
        "x-executor-organization": "acme",
        "x-executor-mcp-account-id": "user_other",
        "x-executor-mcp-organization-id": "org_other",
        "x-executor-mcp-resource-key": "default",
        "x-executor-org-write-access": "allowed",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "v2-session",
        "mcp-protocol-version": "2025-06-18",
        "last-event-id": "7",
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        tracestate: "vendor=1",
      }),
      "v1fwd.token",
    );
    expect(Object.fromEntries(headers)).toEqual({
      authorization: "Bearer v1fwd.token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "v2-session",
      "mcp-protocol-version": "2025-06-18",
      "last-event-id": "7",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      tracestate: "vendor=1",
    });
  });
});

describe("v2 response relay", () => {
  it("relays status, headers and body, dropping www-authenticate", async () => {
    const response = relayV2Response(
      new Response("event: message\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": "v2-session",
          "www-authenticate": 'Bearer realm="v2"',
        },
      }),
      () => undefined,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("mcp-session-id")).toBe("v2-session");
    expect(await response.text()).toBe("event: message\n\n");
  });

  it("keeps a non-401 error as v2 answered it", async () => {
    const response = relayV2Response(new Response("nope", { status: 404 }), () => undefined);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("nope");
  });

  it("turns a 401 into a retryable 503 with no challenge, and logs it", async () => {
    const log = vi.fn();
    const response = relayV2Response(
      new Response("{}", { status: 401, headers: { "www-authenticate": "Bearer" } }),
      log,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32001);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp_v2_forward_credential_refused" }),
    );
  });
});

describe("forwardToV2", () => {
  it("sends the same method and body to v2 with a fresh signed token", async () => {
    const { env, seen } = makeEnv(() => new Response("ok", { status: 202 }));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp?elicitation_mode=native&search_tools=true", {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
          "mcp-session-id": "v2-session",
        },
        body,
      }),
      principal,
      moved,
      env,
      makeDeps(),
    );

    expect(response.status).toBe(202);
    expect(seen).toHaveLength(1);
    const forwarded = seen[0]!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(`${ORIGIN}/mcp?elicitation_mode=native`);
    expect(forwarded.headers.get("mcp-session-id")).toBe("v2-session");
    expect(await forwarded.text()).toBe(body);

    const token = forwarded.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    expect(decodePayload(token)).toEqual({
      v: 1,
      account: "user_EXAMPLE",
      organization: "org_EXAMPLE",
      exp: NOW + FORWARD_TOKEN_TTL_SECONDS,
    });
    expect(token).toBe(
      await mintForwardToken(SECRET, {
        account: "user_EXAMPLE",
        organization: "org_EXAMPLE",
        exp: NOW + FORWARD_TOKEN_TTL_SECONDS,
      }),
    );
  });

  it("names an API-key caller's key, its own organization and its hash", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    await forwardToV2(
      new Request("https://executor.sh/mcp", { method: "POST", body: "{}" }),
      apiKeyPrincipal,
      moved,
      env,
      makeDeps(),
    );

    const token = seen[0]?.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    expect(API_KEY_HASH).toHaveLength(43);
    expect(decodePayload(token)).toEqual({
      v: 1,
      account: "user_EXAMPLE",
      organization: "org_EXAMPLE",
      exp: NOW + FORWARD_TOKEN_TTL_SECONDS,
      apiKey: { id: "api_key_EXAMPLE", organization: "org_KEY_OWNER", hash: API_KEY_HASH },
    });
    expect(signatureVerifies(token, SECRET)).toBe(true);
    expect(rawPayload(token)).not.toContain(API_KEY);
  });

  it("sends no API key for a caller without one", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    await forwardToV2(
      new Request("https://executor.sh/mcp", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      makeDeps(),
    );

    const token = seen[0]?.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    expect(decodePayload(token)).not.toHaveProperty("apiKey");
    expect(signatureVerifies(token, SECRET)).toBe(true);
  });

  it("sends a GET without a body", async () => {
    const { env, seen } = makeEnv(() => new Response(null, { status: 200 }));
    await forwardToV2(
      new Request("https://executor.sh/mcp", { headers: { "mcp-session-id": "s" } }),
      principal,
      moved,
      env,
      makeDeps(),
    );
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.body).toBeNull();
  });

  it("resolves a toolkit slug to its row and names the connection", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    await forwardToV2(
      new Request("https://executor.sh/mcp/toolkits/deploy", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      makeDeps({ deploy: "tk_row_example" }),
    );
    // The caller's own connection to the toolkit: `principal.accountId` is user_EXAMPLE.
    const connection = "v1-59b67fa9ffe6d72010b3b9fa56f5bdb38199f2e1";
    expect(seen[0]?.url).toBe(`${ORIGIN}/mcp?connection=${connection}`);
    const token = seen[0]?.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    expect(decodePayload(token)).toMatchObject({ toolkit: "tk_row_example", connection });
  });

  it("answers an unknown toolkit without calling v2", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp/toolkits/missing", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      makeDeps(),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      TOOLKIT_NOT_FOUND_MESSAGE,
    );
    expect(seen).toHaveLength(0);
  });

  it("forwards a passthrough-mode request to v2 without the mode", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp?mode=passthrough", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      makeDeps(),
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${ORIGIN}/mcp`);
  });

  it("forwards a passthrough-mode toolkit request to its connection", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp/toolkits/deploy?mode=passthrough", {
        method: "POST",
        body: "{}",
      }),
      principal,
      moved,
      env,
      makeDeps({ deploy: "tk_row_example" }),
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(
      `${ORIGIN}/mcp?connection=v1-59b67fa9ffe6d72010b3b9fa56f5bdb38199f2e1`,
    );
  });

  it("answers a retryable 503 when v2 answers 401", async () => {
    const { env } = makeEnv(
      () => new Response("{}", { status: 401, headers: { "www-authenticate": "Bearer" } }),
    );
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      makeDeps(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("answers a retryable 503 when the binding fails", async () => {
    const { env } = makeEnv(() => outage());
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      makeDeps(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
  });

  it("answers a retryable 503 when the toolkit lookup fails", async () => {
    const { env, seen } = makeEnv(() => new Response("ok"));
    const response = await forwardToV2(
      new Request("https://executor.sh/mcp/toolkits/deploy", { method: "POST", body: "{}" }),
      principal,
      moved,
      env,
      { ...makeDeps(), resolveToolkitRowId: outage },
    );
    expect(response.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it("answers a retryable 503, never v1 data, when the binding or secret is missing", async () => {
    const request = () => new Request("https://executor.sh/mcp", { method: "POST", body: "{}" });
    const { env } = makeEnv(() => new Response("ok"));
    for (const missing of ["V2_MCP", "V2_MCP_ORIGIN", "V2_MCP_FORWARD_SECRET"] as const) {
      const response = await forwardToV2(
        request(),
        principal,
        moved,
        { ...env, [missing]: undefined },
        makeDeps(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).not.toBeNull();
    }
  });
});
