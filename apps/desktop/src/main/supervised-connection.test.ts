import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SidecarConnection } from "./sidecar";
import { replaceSupervisedDaemonForDesktop } from "./supervised-connection";

const connection = (baseUrl: string): SidecarConnection => ({
  baseUrl,
  hostname: "localhost",
  port: 4789,
  username: "executor",
  authToken: "token",
  child: null,
  supervisedDaemon: true,
  ownerVersion: "1.5.12",
  ownerClient: "cli",
  ownerExecutablePath: "/tmp/old-executor",
});

const rejectedInstall = (error: unknown): Promise<void> => Effect.runPromise(Effect.fail(error));

describe("replaceSupervisedDaemonForDesktop", () => {
  it("uses the replacement daemon after install succeeds", async () => {
    const stale = connection("http://localhost:4789");
    const fresh = connection("http://localhost:55334");
    let installCalls = 0;
    let waitCalls = 0;
    let attachCalls = 0;

    const result = await replaceSupervisedDaemonForDesktop(stale, {
      install: async () => {
        installCalls += 1;
      },
      waitForAttach: async () => {
        waitCalls += 1;
        return fresh;
      },
      attach: async () => {
        attachCalls += 1;
        return stale;
      },
    });

    expect(result).toBe(fresh);
    expect(installCalls).toBe(1);
    expect(waitCalls).toBe(1);
    expect(attachCalls).toBe(0);
  });

  it("re-probes after install fails instead of returning the stale daemon", async () => {
    const stale = connection("http://localhost:4789");
    const installFailure = { _tag: "InstallFailure" };
    let loggedError: unknown;
    let loggedConnection: SidecarConnection | null = null;
    let waitCalls = 0;
    let attachCalls = 0;

    const result = await replaceSupervisedDaemonForDesktop(stale, {
      install: () => rejectedInstall(installFailure),
      waitForAttach: async () => {
        waitCalls += 1;
        return stale;
      },
      attach: async () => {
        attachCalls += 1;
        return null;
      },
      onInstallFailure: (error, connection) => {
        loggedError = error;
        loggedConnection = connection;
      },
    });

    expect(result).toBeNull();
    expect(waitCalls).toBe(0);
    expect(attachCalls).toBe(1);
    expect(loggedError).toBe(installFailure);
    expect(loggedConnection).toBe(stale);
  });
});
