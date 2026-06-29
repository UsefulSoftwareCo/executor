import { describe, expect, it } from "@effect/vitest";

import {
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  resolveBrowserExecutorServerConnection,
} from "./server-connection";

describe("Executor server connection", () => {
  it("normalizes server origins and API base URLs", () => {
    expect(normalizeExecutorServerOrigin("localhost:4788/")).toBe("http://localhost:4788");
    expect(normalizeExecutorServerOrigin("http://localhost:4788/api")).toBe(
      "http://localhost:4788",
    );
    expect(apiBaseUrlForServerOrigin("http://localhost:4788")).toBe("http://localhost:4788/api");
    expect(originFromApiBaseUrl("http://localhost:4788/api")).toBe("http://localhost:4788");
  });

  it("builds a stable connection from an explicit server origin", () => {
    const connection = normalizeExecutorServerConnection({
      origin: "https://executor.example",
      displayName: "Remote Executor",
    });

    expect(connection).toMatchObject({
      kind: "http",
      key: "http:https://executor.example",
      origin: "https://executor.example",
      apiBaseUrl: "https://executor.example/api",
      displayName: "Remote Executor",
    });
  });

  it("uses the bridge-provided connection when present", () => {
    const connection = resolveBrowserExecutorServerConnection({
      locationOrigin: "https://ignored.example",
      bridge: {
        serverConnection: {
          kind: "desktop-sidecar",
          origin: "http://127.0.0.1:4789",
          displayName: "Desktop sidecar",
        },
      },
    });

    expect(connection.kind).toBe("desktop-sidecar");
    expect(connection.origin).toBe("http://127.0.0.1:4789");
    expect(connection.apiBaseUrl).toBe("http://127.0.0.1:4789/api");
    // The renderer connection carries no auth — the desktop main process injects
    // the bearer header at the session layer.
    expect(getExecutorServerAuthorizationHeader(connection)).toBeNull();
  });

  it("falls back to the location origin with no auth when no bridge is present", () => {
    const connection = resolveBrowserExecutorServerConnection({
      locationOrigin: "http://localhost:4788",
    });

    expect(connection.kind).toBe("http");
    expect(connection.origin).toBe("http://localhost:4788");
    expect(getExecutorServerAuthorizationHeader(connection)).toBeNull();
  });
});
