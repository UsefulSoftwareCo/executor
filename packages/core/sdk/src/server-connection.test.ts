import { describe, expect, it } from "@effect/vitest";

import {
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
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

  it("builds authorization headers from server auth", () => {
    expect(
      getExecutorServerAuthorizationHeader(
        normalizeExecutorServerConnection({
          origin: "http://127.0.0.1:4789",
          auth: {
            kind: "basic",
            username: "executor",
            password: "secret",
          },
        }),
      ),
    ).toBe("Basic ZXhlY3V0b3I6c2VjcmV0");

    expect(
      getExecutorServerAuthorizationHeader(
        normalizeExecutorServerConnection({
          origin: "https://executor.example",
          auth: {
            kind: "bearer",
            token: "remote-token",
          },
        }),
      ),
    ).toBe("Bearer remote-token");
  });

  it("round-trips local server owner manifests", () => {
    const manifest = {
      version: 1 as const,
      kind: "desktop-sidecar" as const,
      pid: 1234,
      startedAt: "2026-05-28T00:00:00.000Z",
      dataDir: "/Users/rhys/.executor",
      scopeDir: "/Users/rhys/.executor",
      connection: normalizeExecutorServerConnection({
        kind: "desktop-sidecar",
        key: "desktop-sidecar",
        origin: "http://127.0.0.1:4789",
        auth: { kind: "basic", username: "executor", password: "secret" },
      }),
      owner: {
        client: "desktop" as const,
        version: "1.2.3",
        executablePath: "/Applications/Executor.app/Contents/MacOS/Executor",
      },
    };

    expect(
      parseExecutorLocalServerManifest(serializeExecutorLocalServerManifest(manifest)),
    ).toEqual(manifest);
    expect(parseExecutorLocalServerManifest("{")).toBeNull();
    expect(parseExecutorLocalServerManifest(JSON.stringify({ ...manifest, pid: -1 }))).toBeNull();
  });
});
