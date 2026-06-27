import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Data, Effect } from "effect";

import { createReconnectingProcess, type ReconnectingChild } from "../e2e/src/vm/tart";
import {
  cleanupCurrentTartResources,
  deleteTartVmAndVerify,
  tartResourceName,
  tartScopePrefix,
  sweepExpiredTartResources,
  terminateTartRunProcess,
  type TartRunProcess,
} from "../e2e/src/vm/tart-lifecycle";
import {
  createTartOwnership,
  readTartOwnership,
  writeTartOwnership,
} from "../e2e/src/vm/tart-ownership";
import { resolveVmRunMetadata } from "../e2e/src/vm/run-scope";

class FakeChild implements ReconnectingChild {
  readonly listeners = {
    error: new Set<() => void>(),
    exit: new Set<() => void>(),
  };
  killed = false;

  on(event: "error" | "exit", listener: () => void) {
    this.listeners[event].add(listener);
  }

  kill() {
    this.killed = true;
  }

  emit(event: "error" | "exit") {
    for (const listener of this.listeners[event]) listener();
  }
}

class FakeTartRunProcess implements TartRunProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly exitOn: NodeJS.Signals | null) {}

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === this.exitOn) this.signalCode = signal;
    return true;
  }
}

class SimulatedTartDeleteFailure extends Data.TaggedError("SimulatedTartDeleteFailure")<{
  readonly name: string;
}> {}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const temporaryRoots: string[] = [];
const temporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "executor-tart-ownership-test-"));
  temporaryRoots.push(root);
  return root;
};

const cleanupEnvironment = (scope: string, root: string) => ({
  E2E_TART_STATE_ROOT: root,
  E2E_VM_RUN_SCOPE: scope,
  GITHUB_REPOSITORY: "example/executor",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
});

const writeOwnership = (
  environment: ReturnType<typeof cleanupEnvironment>,
  os: "linux" | "macos",
  unique: string,
  now = Date.parse("2026-06-26T00:00:00.000Z"),
) => {
  const metadata = resolveVmRunMetadata(environment, now);
  const name = tartResourceName(metadata.scope, os, unique);
  return writeTartOwnership(createTartOwnership(metadata, os, name), environment);
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Tart reconnecting process", () => {
  it("clears retry timers while paused and after close", async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const controller = createReconnectingProcess(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });

    controller.resume();
    await flushMicrotasks();
    children[0]?.emit("exit");
    expect(vi.getTimerCount()).toBe(1);

    controller.pause();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children).toHaveLength(1);

    controller.resume();
    await flushMicrotasks();
    expect(children).toHaveLength(2);
    children[1]?.emit("error");
    expect(vi.getTimerCount()).toBe(1);

    controller.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children).toHaveLength(2);
  });

  it("kills an async child that resolves after the controller is paused", async () => {
    let resolveSpawn: ((child: FakeChild) => void) | undefined;
    const pendingChild = new Promise<FakeChild>((resolve) => {
      resolveSpawn = resolve;
    });
    const controller = createReconnectingProcess(() => pendingChild);
    const child = new FakeChild();

    controller.resume();
    controller.pause();
    resolveSpawn?.(child);
    await flushMicrotasks();

    expect(child.killed).toBe(true);
  });
});

describe("Tart VM cleanup", () => {
  it("derives collision-resistant names from the exact matrix scope", () => {
    const windowsSibling = tartResourceName("run-123-windows", "linux", "1");
    const linuxSibling = tartResourceName("run-123-linux", "linux", "1");

    expect(windowsSibling).toMatch(new RegExp(`^${tartScopePrefix("run-123-windows")}`));
    expect(linuxSibling).toMatch(new RegExp(`^${tartScopePrefix("run-123-linux")}`));
    expect(windowsSibling).not.toBe(linuxSibling);
  });

  it("waits for graceful process exit and escalates to SIGKILL when necessary", async () => {
    const graceful = new FakeTartRunProcess("SIGINT");
    const forced = new FakeTartRunProcess("SIGKILL");

    await terminateTartRunProcess(graceful, { pollAttempts: 1, wait: async () => {} });
    await terminateTartRunProcess(forced, { pollAttempts: 1, wait: async () => {} });

    expect(graceful.signals).toEqual(["SIGINT"]);
    expect(forced.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("reports a tart run process that remains alive after SIGKILL", async () => {
    const stubborn = new FakeTartRunProcess(null);

    await expect(
      terminateTartRunProcess(stubborn, { pollAttempts: 1, wait: async () => {} }),
    ).rejects.toThrow("did not exit after SIGKILL");
    expect(stubborn.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("cleans only VMs carrying exact managed ownership for the current scope", async () => {
    const scope = "run-123-attempt-2-linux";
    const root = temporaryRoot();
    const environment = cleanupEnvironment(scope, root);
    const ownedLedger = writeOwnership(environment, "linux", "owned");
    const siblingScope = "run-123-attempt-2-macos";
    const siblingEnvironment = { ...environment, E2E_VM_RUN_SCOPE: siblingScope };
    const siblingLedger = writeOwnership(siblingEnvironment, "macos", "sibling");
    const unmanaged = tartResourceName(scope, "linux", "unmanaged");
    let entries = [
      { Name: ownedLedger.record.vmName, Running: true, State: "running" },
      { Name: siblingLedger.record.vmName, Running: true, State: "running" },
      { Name: unmanaged, Running: false, State: "stopped" },
    ];
    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "list") return JSON.stringify(entries);
      if (args[0] === "stop" && args.at(-1) === ownedLedger.record.vmName) {
        entries = entries.map((entry) =>
          entry.Name === ownedLedger.record.vmName
            ? { ...entry, Running: false, State: "stopped" }
            : entry,
        );
      }
      if (args[0] === "delete" && args[1] === ownedLedger.record.vmName) {
        entries = entries.filter((entry) => entry.Name !== ownedLedger.record.vmName);
      }
      return "";
    };

    const result = await cleanupCurrentTartResources({
      environment,
      runner,
    });

    expect(result).toEqual({ deleted: 1, ledgersRemoved: 1, scope });
    expect(entries).toEqual([
      { Name: siblingLedger.record.vmName, Running: true, State: "running" },
      { Name: unmanaged, Running: false, State: "stopped" },
    ]);
    expect(readTartOwnership(environment).map(({ record }) => record.vmName)).toEqual([
      siblingLedger.record.vmName,
    ]);
    expect(calls.filter((args) => args[0] === "delete")).toEqual([
      ["delete", ownedLedger.record.vmName],
    ]);
  });

  it("surfaces deletion failures and leftover scoped VMs", async () => {
    const scope = "run-456-macos";
    const root = temporaryRoot();
    const environment = cleanupEnvironment(scope, root);
    const owned = writeOwnership(environment, "macos", "owned");
    const runner = async (args: readonly string[]) => {
      if (args[0] === "list") {
        return JSON.stringify([{ Name: owned.record.vmName, Running: false, State: "stopped" }]);
      }
      if (args[0] === "delete") {
        return Effect.runPromise(
          Effect.fail(new SimulatedTartDeleteFailure({ name: owned.record.vmName })),
        );
      }
      return "";
    };

    await expect(
      cleanupCurrentTartResources({
        environment,
        runner,
      }),
    ).rejects.toThrow("tart cleanup was incomplete");
    expect(readTartOwnership(environment).map(({ record }) => record.vmName)).toEqual([
      owned.record.vmName,
    ]);
  });

  it("sweeps only expired managed VMs from this repository and preserves the current run", async () => {
    const root = temporaryRoot();
    const environment = cleanupEnvironment("current-linux", root);
    const staleEnvironment = {
      ...environment,
      E2E_VM_RUN_SCOPE: "stale-linux",
      GITHUB_RUN_ID: "122",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const youngEnvironment = {
      ...environment,
      E2E_VM_RUN_SCOPE: "young-linux",
      GITHUB_RUN_ID: "121",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const otherRepositoryEnvironment = {
      ...staleEnvironment,
      E2E_VM_RUN_SCOPE: "other-repository-linux",
      GITHUB_REPOSITORY: "someone-else/executor",
    };
    const stale = writeOwnership(staleEnvironment, "linux", "stale");
    const current = writeOwnership(environment, "linux", "current");
    const young = writeOwnership(
      youngEnvironment,
      "linux",
      "young",
      Date.parse("2026-06-26T10:00:00.000Z"),
    );
    const otherRepository = writeOwnership(otherRepositoryEnvironment, "linux", "other");
    const unmanaged = tartResourceName("unmanaged-old-scope", "linux", "unmanaged");
    let entries = [stale, current, young, otherRepository].map(({ record }) => ({
      Name: record.vmName,
      Running: false,
      State: "stopped",
    }));
    entries.push({ Name: unmanaged, Running: false, State: "stopped" });
    const deleted: string[] = [];
    const runner = async (args: readonly string[]) => {
      if (args[0] === "list") return JSON.stringify(entries);
      if (args[0] === "delete" && args[1]) {
        deleted.push(args[1]);
        entries = entries.filter((entry) => entry.Name !== args[1]);
      }
      return "";
    };

    const result = await sweepExpiredTartResources({
      environment,
      minimumAgeHours: 6,
      now: Date.parse("2026-06-26T12:00:00.000Z"),
      runner,
    });

    expect(result).toEqual({
      deleted: 1,
      ledgersRemoved: 1,
      repository: "example/executor",
    });
    expect(deleted).toEqual([stale.record.vmName]);
    expect(entries.map(({ Name }) => Name).sort()).toEqual(
      [current.record.vmName, young.record.vmName, otherRepository.record.vmName, unmanaged].sort(),
    );
    expect(
      readTartOwnership(environment)
        .map(({ record }) => record.vmName)
        .sort(),
    ).toEqual([current.record.vmName, young.record.vmName, otherRepository.record.vmName].sort());
  });

  it("fails before listing VMs when a managed ownership ledger is malformed", async () => {
    const root = temporaryRoot();
    const environment = cleanupEnvironment("current-linux", root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${"0".repeat(64)}.json`), "not-json", "utf8");
    const calls: string[][] = [];

    await expect(
      sweepExpiredTartResources({
        environment,
        minimumAgeHours: 6,
        runner: async (args) => {
          calls.push([...args]);
          return "[]";
        },
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("fails before deletion when tart reports an unknown managed VM state", async () => {
    const root = temporaryRoot();
    const environment = cleanupEnvironment("current-linux", root);
    const staleEnvironment = {
      ...environment,
      E2E_VM_RUN_SCOPE: "stale-linux",
      GITHUB_RUN_ID: "122",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const stale = writeOwnership(staleEnvironment, "linux", "stale");
    const calls: string[][] = [];
    const runner = async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "list"
        ? JSON.stringify([{ Name: stale.record.vmName, Running: false, State: "migrating" }])
        : "";
    };

    await expect(
      sweepExpiredTartResources({
        environment,
        minimumAgeHours: 6,
        now: Date.parse("2026-06-26T12:00:00.000Z"),
        runner,
      }),
    ).rejects.toThrow("unknown or inconsistent state");
    expect(calls).toEqual([["list", "--source", "local", "--format", "json"]]);
    expect(readTartOwnership(environment).map(({ record }) => record.vmName)).toEqual([
      stale.record.vmName,
    ]);
  });

  it("rejects a successful delete command when readback still finds the VM", async () => {
    const name = tartResourceName("run-789-linux", "linux", "owned");
    const runner = async (args: readonly string[]) =>
      args[0] === "list" ? JSON.stringify([{ Name: name, Running: false, State: "stopped" }]) : "";

    await expect(deleteTartVmAndVerify(name, runner)).rejects.toThrow(
      "tart VM still exists after deletion",
    );
  });
});
