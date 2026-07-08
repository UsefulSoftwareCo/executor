import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  parseExecutorLocalServerManifest,
  resolveExecutorServerConfiguredHeaders,
  resolveExecutorServerRequestHeaders,
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

  it("normalizes env-backed server headers", () => {
    const connection = normalizeExecutorServerConnection({
      origin: "https://executor.example",
      headers: {
        " CF-Access-Client-Id ": { kind: "env", name: " EXECUTOR_CF_ACCESS_CLIENT_ID " },
        "CF-Access-Client-Secret": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_SECRET" },
      },
    });

    expect(connection.headers).toEqual({
      "CF-Access-Client-Id": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_ID" },
      "CF-Access-Client-Secret": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_SECRET" },
    });
  });

  it("resolves configured request headers from env without storing values", () => {
    const connection = normalizeExecutorServerConnection({
      origin: "https://executor.example",
      auth: { kind: "bearer", token: "api-token" },
      headers: {
        "CF-Access-Client-Id": { kind: "env", name: "EXECUTOR_CF_ACCESS_CLIENT_ID" },
      },
    });

    expect(
      Effect.runSync(
        resolveExecutorServerConfiguredHeaders(connection, {
          EXECUTOR_CF_ACCESS_CLIENT_ID: "client-id",
        }),
      ),
    ).toEqual({
      "CF-Access-Client-Id": "client-id",
    });
    expect(
      Effect.runSync(
        resolveExecutorServerRequestHeaders(connection, {
          EXECUTOR_CF_ACCESS_CLIENT_ID: "client-id",
        }),
      ),
    ).toEqual({
      "CF-Access-Client-Id": "client-id",
      authorization: "Bearer api-token",
    });
    expect(() => Effect.runSync(resolveExecutorServerConfiguredHeaders(connection, {}))).toThrow(
      'Server profile header "CF-Access-Client-Id" references unset environment variable "EXECUTOR_CF_ACCESS_CLIENT_ID".',
    );
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
        headers: {
          "CF-Access-Client-Id": { kind: "env" as const, name: "EXECUTOR_CF_ACCESS_CLIENT_ID" },
        },
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
