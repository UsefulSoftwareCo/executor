import { describe, expect, it } from "@effect/vitest";

import { browserTracesResponse } from "./browser-traces";

const makeRequest = (init?: RequestInit & { path?: string }) =>
  new Request(`https://executor.sh${init?.path ?? "/v1/traces"}`, {
    method: "POST",
    body: "{}",
    ...init,
  });

const baseEnv = {
  AXIOM_TOKEN: "axiom-secret",
  AXIOM_DATASET: "executor-cloud",
} as Env;

describe("browserTracesResponse", () => {
  it("ignores non-/v1/traces requests entirely", () => {
    expect(browserTracesResponse(makeRequest({ path: "/api/tools" }), baseEnv)).toBeNull();
  });

  it("drops batches silently when Axiom is not configured", async () => {
    const response = await browserTracesResponse(
      makeRequest({ headers: { cookie: "wos-session=abc" } }),
      {} as Env,
    );
    expect(response?.status).toBe(204);
  });

  it("rejects anonymous posts", async () => {
    const response = await browserTracesResponse(makeRequest(), baseEnv);
    expect(response?.status).toBe(401);
  });

  it("forwards to Axiom with server-held credentials and hides the upstream body", async () => {
    let seen: { url: string; auth: string | null; dataset: string | null } | undefined;
    const response = await browserTracesResponse(
      makeRequest({ headers: { cookie: "wos-session=abc" } }),
      baseEnv,
      (async (url: RequestInfo | URL, init?: RequestInit) => {
        seen = {
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          dataset: new Headers(init?.headers).get("x-axiom-dataset"),
        };
        return new Response("axiom-internals", { status: 200 });
      }) as typeof fetch,
    );
    expect(seen?.url).toBe("https://api.axiom.co/v1/traces");
    expect(seen?.auth).toBe("Bearer axiom-secret");
    expect(seen?.dataset).toBe("executor-cloud");
    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
  });

  it("reports upstream failure as 502 without leaking detail", async () => {
    const response = await browserTracesResponse(
      makeRequest({ headers: { cookie: "wos-session=abc" } }),
      baseEnv,
      (async () => new Response("denied", { status: 403 })) as typeof fetch,
    );
    expect(response?.status).toBe(502);
  });

  it("refuses oversized batches", async () => {
    const response = await browserTracesResponse(
      makeRequest({
        headers: {
          cookie: "wos-session=abc",
          "content-length": String(3_000_000),
        },
      }),
      baseEnv,
    );
    expect(response?.status).toBe(413);
  });

  it("only accepts POST", async () => {
    const response = await browserTracesResponse(
      new Request("https://executor.sh/v1/traces", { method: "GET" }),
      baseEnv,
    );
    expect(response?.status).toBe(405);
  });
});
