import { describe, expect, it } from "@effect/vitest";

import {
  canAutoStartCliServerConnection,
  chooseCliServerConnectionWithActiveLocal,
  parseCliExecutorServerConnection,
  withCliServerAuthFallback,
} from "./server-connection";

describe("CLI server connection", () => {
  it("treats localhost HTTP servers as auto-startable daemon targets", () => {
    const connection = parseCliExecutorServerConnection("localhost:4788", {});

    expect(connection.origin).toBe("http://localhost:4788");
    expect(connection.apiBaseUrl).toBe("http://localhost:4788/api");
    expect(canAutoStartCliServerConnection(connection)).toBe(true);
  });

  it("treats hosted HTTPS servers as explicit server connections", () => {
    const connection = parseCliExecutorServerConnection("https://executor.example/api", {
      EXECUTOR_API_KEY: "key_123",
    });

    expect(connection.origin).toBe("https://executor.example");
    expect(connection.apiBaseUrl).toBe("https://executor.example/api");
    expect(connection.auth).toEqual({ kind: "bearer", token: "key_123" });
    expect(canAutoStartCliServerConnection(connection)).toBe(false);
  });

  it("adds environment auth only when a profile did not carry auth", () => {
    const fromProfile = parseCliExecutorServerConnection("https://executor.example", {});
    expect(withCliServerAuthFallback(fromProfile, { EXECUTOR_API_KEY: "key_123" }).auth).toEqual({
      kind: "bearer",
      token: "key_123",
    });

    const storedAuth = parseCliExecutorServerConnection("https://executor.example", {
      EXECUTOR_API_KEY: "stored",
    });
    expect(withCliServerAuthFallback(storedAuth, { EXECUTOR_API_KEY: "env" }).auth).toEqual({
      kind: "bearer",
      token: "stored",
    });
  });

  it("reads a local server bearer token from EXECUTOR_AUTH_TOKEN", () => {
    const connection = parseCliExecutorServerConnection("http://127.0.0.1:4789", {
      EXECUTOR_AUTH_TOKEN: "desktop-token",
    });

    expect(connection.auth).toEqual({ kind: "bearer", token: "desktop-token" });
    // A connection carrying explicit auth is not an auto-startable local daemon.
    expect(canAutoStartCliServerConnection(connection)).toBe(false);
  });

  it("never auto-starts desktop sidecar profiles", () => {
    const connection = {
      ...parseCliExecutorServerConnection("http://127.0.0.1:4789", {}),
      kind: "desktop-sidecar" as const,
    };

    expect(canAutoStartCliServerConnection(connection)).toBe(false);
  });

  it("prefers EXECUTOR_API_KEY over EXECUTOR_AUTH_TOKEN", () => {
    const connection = parseCliExecutorServerConnection("https://executor.example", {
      EXECUTOR_API_KEY: "key_123",
      EXECUTOR_AUTH_TOKEN: "token_456",
    });
    expect(connection.auth).toEqual({ kind: "bearer", token: "key_123" });
  });

  it("attaches implicit local requests to the active local owner", () => {
    const requested = parseCliExecutorServerConnection("http://localhost:4788", {});
    const active = {
      version: 1 as const,
      kind: "desktop-sidecar" as const,
      pid: process.pid,
      startedAt: "2026-05-28T00:00:00.000Z",
      dataDir: "/tmp/executor",
      scopeDir: "/tmp/executor",
      connection: parseCliExecutorServerConnection("http://127.0.0.1:4789", {
        EXECUTOR_AUTH_TOKEN: "desktop-token",
      }),
      owner: {
        client: "desktop" as const,
        version: "1.2.3",
        executablePath: "/Applications/Executor.app/Contents/MacOS/Executor",
      },
    };

    const decision = chooseCliServerConnectionWithActiveLocal({
      requested,
      source: "active-local",
      active,
    });

    expect(decision).toMatchObject({
      kind: "use-active",
      connection: {
        origin: "http://127.0.0.1:4789",
        auth: {
          kind: "bearer",
          token: "desktop-token",
        },
      },
    });
  });

  it("blocks local auto-start when another local owner is active", () => {
    const requested = parseCliExecutorServerConnection("http://localhost:4788", {});
    const active = {
      version: 1 as const,
      kind: "desktop-sidecar" as const,
      pid: process.pid,
      startedAt: "2026-05-28T00:00:00.000Z",
      dataDir: "/tmp/executor",
      scopeDir: "/tmp/executor",
      connection: parseCliExecutorServerConnection("http://127.0.0.1:4789", {
        EXECUTOR_AUTH_TOKEN: "desktop-token",
      }),
      owner: {
        client: "desktop" as const,
        version: "1.2.3",
        executablePath: "/Applications/Executor.app/Contents/MacOS/Executor",
      },
    };

    expect(
      chooseCliServerConnectionWithActiveLocal({
        requested,
        source: "explicit",
        active,
      }).kind,
    ).toBe("conflict");
  });
});
