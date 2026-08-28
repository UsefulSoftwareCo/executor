/**
 * The classifier is pure and tested next door; this covers what `startSidecar`
 * DOES with each verdict — which is where the reported symptom lived. A child
 * interrupted from outside must leave the crash channel untouched and tell the
 * window no report was sent, while a genuine post-boot death must still be
 * reported. Both halves are driven through the real `startSidecar`, with only
 * the process spawn and Electron's environment replaced.
 */

import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: vi.mock must come from vitest itself for mock hoisting to resolve
import { vi } from "vitest";
import { EventEmitter } from "node:events";

let appQuitting = false;
const crashReports: string[] = [];

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.6.0", on: () => {} },
}));

vi.mock("electron-log/main.js", () => {
  const scope = () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} });
  return { default: { scope }, scope };
});

vi.mock("./local-auth", () => ({ loadOrMintLocalAuthToken: () => "test-token" }));

vi.mock("./settings", () => ({ getServerSettings: () => ({ port: 4789 }) }));

vi.mock("./diagnostics", () => ({
  reportSidecarCrash: (message: string) => {
    crashReports.push(message);
  },
  sidecarCrashReportingEnv: () => ({}),
}));

vi.mock("./supervised-daemon", () => ({ resolveSupervisedDaemonAttach: () => null }));

vi.mock("./app-quit", () => ({ isAppQuitting: () => appQuitting }));

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4242;
  exitCode: number | null = null;
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

// The packaged branch of `resolveSidecarCommand` reads Electron's resources
// path; nothing is executed, since the spawn itself is replaced below.
(process as { resourcesPath?: string }).resourcesPath ??= "/tmp/executor-test-resources";

let spawned: FakeChild | null = null;

vi.mock("node:child_process", () => ({
  spawn: () => {
    spawned = new FakeChild();
    return spawned;
  },
}));

const { startSidecar, onUnexpectedSidecarExit, stopSidecar } = await import("./sidecar");

/** Boot a sidecar to the point `startSidecar` resolves, then hand back the child. */
const bootedSidecar = async (): Promise<FakeChild> => {
  const started = startSidecar();
  // The child announces readiness with the structured stdout sentinel.
  await Promise.resolve();
  spawned?.stdout.emit("data", Buffer.from("EXECUTOR_READY:4789\n"));
  await started;
  // oxlint-disable-next-line executor/no-non-null-assertion -- the spawn mock always records a child
  return spawned!;
};

interface Observed {
  readonly notices: { readonly reported: boolean }[];
  readonly reports: string[];
}

/** Boot, drive one post-boot exit, and report what the app did about it. */
const exitAfterBoot = async (
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null },
  options: { readonly quitting?: boolean; readonly stopFirst?: boolean } = {},
): Promise<Observed> => {
  appQuitting = false;
  crashReports.length = 0;
  const notices: { readonly reported: boolean }[] = [];
  onUnexpectedSidecarExit((notice) => notices.push(notice));

  const child = await bootedSidecar();
  child.stderr.emit("data", Buffer.from("some trailing output\n"));
  if (options.stopFirst) {
    const stopping = stopSidecar(child as never);
    child.emit("exit", exit.code, exit.signal);
    await stopping;
  } else {
    appQuitting = options.quitting ?? false;
    child.emit("exit", exit.code, exit.signal);
  }
  await Promise.resolve();
  return { notices, reports: [...crashReports] };
};

describe("startSidecar post-boot exit handling", () => {
  it("does not report an outside interrupt, and tells the window nothing was sent", async () => {
    // A group-wide Ctrl-C reaches the child because it shares Electron's
    // process group; Node surfaces it as 128+SIGINT. The server really is gone,
    // so the window must still be told — but no crash report exists to claim.
    const { notices, reports } = await exitAfterBoot({ code: 130, signal: null });

    expect(reports).toEqual([]);
    expect(notices).toEqual([{ reported: false }]);
  });

  it("does not report a SIGTERM the app did not send", async () => {
    const { notices, reports } = await exitAfterBoot({ code: null, signal: "SIGTERM" });

    expect(reports).toEqual([]);
    expect(notices).toEqual([{ reported: false }]);
  });

  it("still reports a genuine post-boot death and says a report was sent", async () => {
    const { notices, reports } = await exitAfterBoot({ code: 1, signal: null });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("code=1");
    expect(notices).toEqual([{ reported: true }]);
  });

  it("still reports an abnormal death signal", async () => {
    const { notices, reports } = await exitAfterBoot({ code: null, signal: "SIGSEGV" });

    expect(reports).toHaveLength(1);
    expect(notices).toEqual([{ reported: true }]);
  });

  it("says nothing at all when the app itself stopped the sidecar", async () => {
    const { notices, reports } = await exitAfterBoot(
      { code: null, signal: "SIGTERM" },
      { stopFirst: true },
    );

    expect(reports).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("says nothing at all when the app is quitting", async () => {
    // Quit tears the tree down; the window is going away, so surfacing a
    // disconnected screen at that moment would be its own bug.
    const { notices, reports } = await exitAfterBoot(
      { code: 130, signal: null },
      { quitting: true },
    );

    expect(reports).toEqual([]);
    expect(notices).toEqual([]);
  });
});
