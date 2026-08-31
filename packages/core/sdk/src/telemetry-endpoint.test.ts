import { describe, expect, it } from "@effect/vitest";

import { endpointForTelemetry, endpointTelemetryAttributes } from "./telemetry-endpoint";

// Synthetic placeholders only.
const QUERY_TOKEN = "synthetic-query-token";
const USERINFO_PASSWORD = "synthetic-userinfo-password";

describe("endpointForTelemetry", () => {
  it("strips a credential carried in the query string", () => {
    // The shape the MCP preset list ships and the add-flow passes through raw.
    expect(endpointForTelemetry(`https://mcp.example.test/mcp?token=${QUERY_TOKEN}`)).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("strips a credential carried in URL userinfo", () => {
    expect(endpointForTelemetry(`https://svc-user:${USERINFO_PASSWORD}@mcp.example.test/mcp`)).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("strips query, fragment, and userinfo together", () => {
    const scrubbed = endpointForTelemetry(
      `https://svc-user:${USERINFO_PASSWORD}@mcp.example.test/mcp?token=${QUERY_TOKEN}#frag`,
    );
    expect(scrubbed).toBe("https://mcp.example.test/mcp");
    expect(scrubbed).not.toContain(QUERY_TOKEN);
    expect(scrubbed).not.toContain(USERINFO_PASSWORD);
  });

  it("leaves a credential-free endpoint intact", () => {
    expect(endpointForTelemetry("https://mcp.example.test/mcp")).toBe(
      "https://mcp.example.test/mcp",
    );
  });

  it("returns credential-free unparseable input as-is", () => {
    expect(endpointForTelemetry("not a url")).toBe("not a url");
  });

  it("truncates an unparseable paste at the first `?` instead of passing it through", () => {
    // A space in the host makes this unparseable, but the `?token=…` shape is
    // still a credential and must not be stamped verbatim.
    const scrubbed = endpointForTelemetry(`http://exa mple.test/mcp?token=${QUERY_TOKEN}`);
    expect(scrubbed).toBe("http://exa mple.test/mcp");
    expect(scrubbed).not.toContain(QUERY_TOKEN);
  });

  it("drops a userinfo-looking prefix from an unparseable paste", () => {
    const scrubbed = endpointForTelemetry(
      `http://svc-user:${USERINFO_PASSWORD}@exa mple.test/mcp?token=${QUERY_TOKEN}`,
    );
    expect(scrubbed).toBe("exa mple.test/mcp");
    expect(scrubbed).not.toContain(QUERY_TOKEN);
    expect(scrubbed).not.toContain(USERINFO_PASSWORD);
  });
});

describe("endpointTelemetryAttributes", () => {
  it("keeps the endpoint debuggable without exposing the credential", () => {
    const attributes = endpointTelemetryAttributes(
      "mcp.endpoint",
      `https://svc-user:${USERINFO_PASSWORD}@mcp.example.test/mcp?token=${QUERY_TOKEN}`,
    );

    expect(attributes).toEqual({
      "mcp.endpoint": "https://mcp.example.test/mcp",
      "mcp.endpoint.origin": "https://mcp.example.test",
      "mcp.endpoint.has_query": true,
      "mcp.endpoint.has_fragment": false,
      "mcp.endpoint.has_userinfo": true,
    });
    expect(JSON.stringify(attributes)).not.toContain(QUERY_TOKEN);
    expect(JSON.stringify(attributes)).not.toContain(USERINFO_PASSWORD);
  });

  it("reports absence of both credential shapes for a plain endpoint", () => {
    expect(endpointTelemetryAttributes("mcp.endpoint", "https://mcp.example.test/mcp")).toEqual({
      "mcp.endpoint": "https://mcp.example.test/mcp",
      "mcp.endpoint.origin": "https://mcp.example.test",
      "mcp.endpoint.has_query": false,
      "mcp.endpoint.has_fragment": false,
      "mcp.endpoint.has_userinfo": false,
    });
  });

  it("reports a fragment-only malformed endpoint honestly", () => {
    // The `#` starts a fragment, not a query — `has_query` must not claim one,
    // and the fragment's presence must be recorded as its own signal.
    const attributes = endpointTelemetryAttributes(
      "mcp.endpoint",
      `http://exa mple.test/mcp#access_token=${QUERY_TOKEN}`,
    );

    expect(attributes["mcp.endpoint"]).toBe("http://exa mple.test/mcp");
    expect(attributes["mcp.endpoint.has_query"]).toBe(false);
    expect(attributes["mcp.endpoint.has_fragment"]).toBe(true);
    expect(JSON.stringify(attributes)).not.toContain(QUERY_TOKEN);
  });

  it("reports a fragment on a parseable endpoint", () => {
    const attributes = endpointTelemetryAttributes(
      "mcp.endpoint",
      `https://mcp.example.test/mcp#access_token=${QUERY_TOKEN}`,
    );

    expect(attributes["mcp.endpoint"]).toBe("https://mcp.example.test/mcp");
    expect(attributes["mcp.endpoint.has_query"]).toBe(false);
    expect(attributes["mcp.endpoint.has_fragment"]).toBe(true);
    expect(JSON.stringify(attributes)).not.toContain(QUERY_TOKEN);
  });

  it("degrades an unparseable paste without leaking either credential shape", () => {
    const attributes = endpointTelemetryAttributes(
      "mcp.endpoint",
      `http://svc-user:${USERINFO_PASSWORD}@exa mple.test/mcp?token=${QUERY_TOKEN}`,
    );

    expect(attributes).toEqual({
      "mcp.endpoint": "exa mple.test/mcp",
      "mcp.endpoint.has_query": true,
      "mcp.endpoint.has_fragment": false,
      "mcp.endpoint.has_userinfo": true,
    });
    expect(JSON.stringify(attributes)).not.toContain(QUERY_TOKEN);
    expect(JSON.stringify(attributes)).not.toContain(USERINFO_PASSWORD);
  });
});
