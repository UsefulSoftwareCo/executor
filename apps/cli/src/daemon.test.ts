import { describe, expect, it } from "@effect/vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  canAutoStartLocalDaemonForHost,
  isDevCliEntrypoint,
  isExecutorServerReachable,
  planServiceInstall,
  spawnDetached,
  terminateSpawnedDetachedProcess,
} from "./daemon";

describe("isDevCliEntrypoint", () => {
  it("treats source entrypoints as dev", () => {
    expect(isDevCliEntrypoint("/Users/x/src/executor/apps/cli/src/main.ts")).toBe(true);
    expect(isDevCliEntrypoint("/Users/x/dist/main.js")).toBe(true);
  });

  it("treats compiled single-file binaries as NOT dev (both Unix and Windows)", () => {
    // Bun's embedded filesystem: `/$bunfs/...` on Unix, `B:\~BUN\...` on Windows.
    // Missing the Windows form made a real `executor.exe` look like a dev
    // checkout, so `service install` wrongly refused on Windows.
    expect(isDevCliEntrypoint("/$bunfs/root/main.js")).toBe(false);
    expect(isDevCliEntrypoint("B:/~BUN/root/main.js")).toBe(false);
    expect(isDevCliEntrypoint("B:\\~BUN\\root\\main.js")).toBe(false);
  });

  it("only treats a DRIVE-ROOTED ~BUN as compiled (a ~BUN dir mid-tree stays dev)", () => {
    // The Windows bunfs root is `<drive>:\~BUN\...`; a dev checkout that merely
    // contains a `~BUN` directory must not be misread as a compiled binary.
    expect(isDevCliEntrypoint("/home/user/~BUN/project/src/main.ts")).toBe(true);
    expect(isDevCliEntrypoint("C:/Users/dev/~BUN/src/main.ts")).toBe(true);
  });

  it("is false when no entrypoint is known", () => {
    expect(isDevCliEntrypoint(undefined)).toBe(false);
  });
});

describe("canAutoStartLocalDaemonForHost", () => {
  it("allows loopback hosts", () => {
    expect(canAutoStartLocalDaemonForHost("localhost")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("127.0.0.1")).toBe(true);
    expect(canAutoStartLocalDaemonForHost("[::1]")).toBe(true);
  });

  it("does not treat wildcard binds as loopback", () => {
    expect(canAutoStartLocalDaemonForHost("0.0.0.0")).toBe(false);
    expect(canAutoStartLocalDaemonForHost("::")).toBe(false);
  });
});

const waitForFile = (path: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (existsSync(path)) return true;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    return false;
  });

describe("spawnDetached", () => {
  it.effect("can terminate the spawned detached process", () =>
    Effect.gen(function* () {
      const workDir = mkdtempSync(join(tmpdir(), "executor-daemon-spawn-"));
      const readyMarker = join(workDir, "ready");
      const terminatedMarker = join(workDir, "terminated");

      try {
        const child = yield* Effect.acquireRelease(
          spawnDetached({
            command: process.execPath,
            args: [
              "-e",
              "const fs = require('node:fs'); fs.writeFileSync(process.env.READY_FILE, 'ok'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.TERMINATED_FILE, 'ok'); process.exit(0); }); setInterval(() => {}, 1000)",
            ],
            env: { ...process.env, READY_FILE: readyMarker, TERMINATED_FILE: terminatedMarker },
          }),
          (child) => terminateSpawnedDetachedProcess(child).pipe(Effect.ignore),
        );

        expect(child.pid).toBeGreaterThan(0);
        const ready = yield* waitForFile(readyMarker);
        expect(ready).toBe(true);
        yield* terminateSpawnedDetachedProcess(child);
        const terminated = yield* waitForFile(terminatedMarker);
        expect(terminated).toBe(true);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("isExecutorServerReachable", () => {
  it.effect("probes the unauthenticated /api/health endpoint without forwarding a credential", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise(
          () =>
            new Promise<{ server: Server; port: number }>((resolve, reject) => {
              const server = createServer((request, response) => {
                const url = new URL(request.url ?? "/", "http://127.0.0.1");
                // The probe must NOT send Authorization, and must hit /api/health.
                if (url.pathname === "/api/health" && !request.headers.authorization) {
                  response.writeHead(200, { "content-type": "text/plain" });
                  response.end("ok");
                  return;
                }
                response.writeHead(404);
                response.end();
              });
              const onError = (error: Error) => reject(error);
              server.once("error", onError);
              server.listen(0, "127.0.0.1", () => {
                server.off("error", onError);
                const address = server.address() as AddressInfo;
                resolve({ server, port: address.port });
              });
            }),
        ),
        ({ server }) =>
          Effect.tryPromise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );

      const reachable = yield* isExecutorServerReachable({
        baseUrl: `http://127.0.0.1:${server.port}`,
      });

      expect(reachable).toBe(true);
    }),
  );
});

describe("planServiceInstall", () => {
  it("no-ops when the supervised service already runs this version on the requested port", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: "cli-daemon",
        activeVersion: "1.5.11",
        activePort: 4789,
        requestedPort: 4789,
        currentVersion: "1.5.11",
      }),
    ).toBe("noop");
  });

  it("reinstalls when the supervised service runs an older version", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: "cli-daemon",
        activeVersion: "1.5.10",
        activePort: 4789,
        requestedPort: 4789,
        currentVersion: "1.5.11",
      }),
    ).toBe("reinstall");
  });

  it("reinstalls when the version matches but the requested service port changed", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: "cli-daemon",
        activeVersion: "1.5.11",
        activePort: 4789,
        requestedPort: 5790,
        currentVersion: "1.5.11",
      }),
    ).toBe("reinstall");
  });

  it("reinstalls when the version and port match but the service points at another executable", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: "cli-daemon",
        activeVersion: "1.5.11",
        activeExecutablePath:
          "/Applications/Executor.app/Contents/Resources/sidecar/executor-sidecar",
        activePort: 4789,
        requestedPort: 4789,
        currentVersion: "1.5.11",
        currentExecutablePath: "/Applications/Executor.app/Contents/Resources/executor/executor",
      }),
    ).toBe("reinstall");
  });

  it("takes over when a detached CLI daemon owns the manifest while the service is running elsewhere", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: "cli-daemon",
        activePid: 2002,
        servicePid: 1001,
        activeVersion: "1.5.11",
        activePort: 4788,
        requestedPort: 55334,
        currentVersion: "1.5.11",
      }),
    ).toBe("takeover-then-install");
  });

  it("reinstalls when the supervised service is up but manifest details are unavailable", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: null,
        activeVersion: null,
        activePort: null,
        requestedPort: 4789,
        currentVersion: "1.5.11",
      }),
    ).toBe("reinstall");
  });

  it("takes over when another local server kind owns the data directory", () => {
    expect(
      planServiceInstall({
        registered: true,
        running: true,
        activeKind: "foreground",
        activeVersion: "1.5.11",
        activePort: 4789,
        requestedPort: 4789,
        currentVersion: "1.5.11",
      }),
    ).toBe("takeover-then-install");
    expect(
      planServiceInstall({
        registered: false,
        running: false,
        activeKind: "desktop-sidecar",
        activeVersion: "1.5.10",
        activePort: 4789,
        requestedPort: 4789,
        currentVersion: "1.5.11",
      }),
    ).toBe("takeover-then-install");
  });

  it("takes over on a fresh install path before writing the service", () => {
    expect(
      planServiceInstall({
        registered: false,
        running: false,
        activeKind: null,
        activeVersion: null,
        activePort: null,
        requestedPort: 4789,
        currentVersion: "1.5.11",
      }),
    ).toBe("takeover-then-install");
  });
});
