import { describe, expect, it } from "@effect/vitest";
import { createServer } from "node:net";
import * as Effect from "effect/Effect";

import {
  buildDaemonSpawnSpec,
  canAutoStartLocalDaemonForHost,
  chooseDaemonPort,
  isDevCliEntrypoint,
  parseDaemonBaseUrl,
} from "../apps/cli/src/daemon";

describe("daemon bootstrap helpers", () => {
  it("parses default port when none is provided", () => {
    const parsed = parseDaemonBaseUrl("http://localhost", 4788);
    expect(parsed).toEqual({ hostname: "localhost", port: 4788 });
  });

  it("parses explicit port from base url", () => {
    const parsed = parseDaemonBaseUrl("http://127.0.0.1:9001", 4788);
    expect(parsed).toEqual({ hostname: "127.0.0.1", port: 9001 });
  });

  it("rejects non-http schemes for auto-start", () => {
    expect(() => parseDaemonBaseUrl("https://localhost:4788", 4788)).toThrow(
      "Only http:// base URLs are supported",
    );
  });

  it("only auto-starts for local hosts", () => {
    expect(canAutoStartLocalDaemonForHost("localhost")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("127.0.0.1")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("::1")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("api.example.com")).toBe(false);
  });

  it("treats source entrypoints as dev mode but excludes bun embedded paths", () => {
    expect(isDevCliEntrypoint("/repo/apps/cli/src/main.ts")).toBe(true);
    expect(isDevCliEntrypoint("/repo/apps/cli/src/main.js")).toBe(true);
    expect(isDevCliEntrypoint("/$bunfs/root/main.js")).toBe(false);
    expect(isDevCliEntrypoint("/usr/local/bin/executor")).toBe(false);
    expect(isDevCliEntrypoint(undefined)).toBe(false);
  });

  it("builds bun-run spec in dev mode", () => {
    const spec = buildDaemonSpawnSpec({
      port: 4788,
      hostname: "localhost",
      isDevMode: true,
      scriptPath: "/repo/apps/cli/src/main.ts",
      executablePath: "/ignored",
    });

    expect(spec.command).toBe("bun");
    expect(spec.args).toEqual([
      "run",
      "/repo/apps/cli/src/main.ts",
      "daemon",
      "run",
      "--port",
      "4788",
      "--hostname",
      "localhost",
      "--foreground",
    ]);
  });

  it("builds executable spec outside dev mode", () => {
    const spec = buildDaemonSpawnSpec({
      port: 5000,
      hostname: "127.0.0.1",
      isDevMode: false,
      scriptPath: undefined,
      executablePath: "/usr/local/bin/executor",
    });

    expect(spec.command).toBe("/usr/local/bin/executor");
    expect(spec.args).toEqual([
      "daemon",
      "run",
      "--port",
      "5000",
      "--hostname",
      "127.0.0.1",
      "--foreground",
    ]);
  });

  it("propagates allowed hosts as repeated flags", () => {
    const spec = buildDaemonSpawnSpec({
      port: 4788,
      hostname: "0.0.0.0",
      isDevMode: false,
      scriptPath: undefined,
      executablePath: "/usr/local/bin/executor",
      allowedHosts: ["my.box", "other.host"],
    });

    expect(spec.args).toEqual([
      "daemon",
      "run",
      "--port",
      "4788",
      "--hostname",
      "0.0.0.0",
      "--foreground",
      "--allowed-host",
      "my.box",
      "--allowed-host",
      "other.host",
    ]);
  });

  it("fails in dev mode when script path is missing", () => {
    expect(() =>
      buildDaemonSpawnSpec({
        port: 4788,
        hostname: "localhost",
        isDevMode: true,
        scriptPath: undefined,
        executablePath: "/usr/local/bin/executor",
      }),
    ).toThrow("Cannot auto-start daemon in dev mode");
  });

  it("falls back when preferred daemon port is occupied", async () => {
    const blocker = createServer();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.callback<void, Error>((resume) => {
              blocker.once("error", (error) => resume(Effect.fail(error)));
              blocker.listen({ port: 0, host: "127.0.0.1" }, () =>
                resume(Effect.succeed(undefined)),
              );
            }),
            () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    blocker.close(() => resolve());
                  }),
              ),
          );

          const occupied = (() => {
            const address = blocker.address();
            return typeof address === "object" && address !== null ? address.port : 0;
          })();

          const picked = yield* chooseDaemonPort({
            preferredPort: occupied,
            hostname: "127.0.0.1",
          });
          expect(picked).not.toBe(occupied);
        }),
      ),
    );
  });
});
