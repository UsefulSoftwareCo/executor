import { describe, expect, it } from "@effect/vitest";
import { limitRequestBody } from "./request-limits";

const streamedRequest = (chunks: readonly string[], headers?: HeadersInit) => {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      const value = chunks[index++];
      if (value === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(value));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    request: new Request("https://example.test/api/import?format=json", {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit),
    cancelled: () => cancelled,
  };
};

describe("request body boundary", () => {
  it("preserves body, URL, method and headers at the exact byte limit", async () => {
    const { request } = streamedRequest(['{"a":', '"é"}'], {
      "content-type": "application/json",
      authorization: "Bearer fixture",
    });
    const limited = await limitRequestBody(request, 10);
    expect(limited).toBeInstanceOf(Request);
    if (!(limited instanceof Request)) return;
    expect(limited.url).toBe(request.url);
    expect(limited.method).toBe("POST");
    expect(limited.headers.get("authorization")).toBe("Bearer fixture");
    expect(await limited.json()).toEqual({ a: "é" });
  });
  for (const headers of [undefined, { "content-length": "1" }]) {
    it(`rejects oversized streamed bodies with ${headers ? "understated" : "absent"} length`, async () => {
      const source = streamedRequest(["123", "456", "789", "more"], headers);
      const response = await limitRequestBody(source.request, 5);
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) return;
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "Request body too large" });
      expect(source.cancelled()).toBe(true);
    });
  }
  it("rejects an oversized declared length before reading", async () => {
    const source = streamedRequest(["body"], { "content-length": "100" });
    const response = await limitRequestBody(source.request, 5);
    expect(response instanceof Response && response.status).toBe(413);
    expect(source.cancelled()).toBe(true);
  });
  it("passes bodyless requests through", async () => {
    const request = new Request("https://example.test/mcp");
    expect(await limitRequestBody(request, 5)).toBe(request);
  });
});
