import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import { Data, Effect } from "effect";

import {
  KVM_ACCOUNT_FIXTURES,
  KVM_CLAUDE_EXECUTE_CODE,
  createKvmAccountFixture,
  createKvmReplayBrain,
  isLoopbackHttpUrl,
  runKvmGuestClaude,
} from "../e2e/desktop-kvm/guest-runtime";
import {
  LINUX_KVM_DESKTOP_CAPABILITIES,
  LinuxKvmUnavailableError,
  createLinuxKvmDesktopProvider,
  preflightLinuxKvm,
  type LinuxKvmPreflightRuntime,
} from "../e2e/src/vm/linux-kvm";
import {
  cleanupLibvirtLinuxKvmFromLedger,
  createLinuxKvmFinalizerStack,
  libvirtDomainArgs,
  linuxKvmCloudInit,
  linuxKvmOwnerIdentity,
  linuxKvmOwnerIdentityMatches,
  linuxKvmOwnerStatus,
  linuxKvmRunScope,
  sweepStaleLibvirtLinuxKvm,
  type LinuxKvmCleanupHostProcess,
  type LinuxKvmCleanupRuntime,
  type LinuxKvmOwnerIdentity,
  type LinuxKvmStaleSweepRuntime,
} from "../e2e/src/vm/linux-kvm-libvirt";
import { cleanupLinuxKvmLedger, sweepLinuxKvmRepository } from "../e2e/scripts/cleanup-linux-kvm";
import { projectDefinition } from "../e2e/src/project-matrix";

class SimulatedPreflightFailure extends Data.TaggedError("SimulatedPreflightFailure")<{
  readonly dependency: string;
}> {}

const failProbe = (dependency: string) =>
  Effect.runPromise(Effect.fail(new SimulatedPreflightFailure({ dependency })));

const availableRuntime = (report = vi.fn()): LinuxKvmPreflightRuntime => ({
  access: async () => undefined,
  exec: async (command) => ({ stdout: `${command} available`, stderr: "" }),
  report,
});

const unavailableRuntime = (report = vi.fn()): LinuxKvmPreflightRuntime => ({
  access: () => failProbe("/dev/kvm"),
  exec: async (command) => {
    if (command === "ffmpeg") return { stdout: "ffmpeg available", stderr: "" };
    return failProbe(command);
  },
  report,
});

const listenOnLoopback = (server: ReturnType<typeof createKvmAccountFixture>) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: test fixture adapts node:http listen into a promise
        reject(new Error("test fixture did not publish a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });

const closeServer = (server: ReturnType<typeof createKvmAccountFixture>) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const writeTestCleanupLedger = (
  path: string,
  input: {
    readonly runScope: string;
    readonly domainName: string;
    readonly libvirtUri: string;
    readonly workRoot: string;
    readonly workDir: string;
    readonly hostProcesses?: ReadonlyArray<LinuxKvmCleanupHostProcess>;
    readonly createdAt?: string;
    readonly repositoryScope?: string;
    readonly owner?: {
      readonly pid: number;
      readonly bootId: string;
      readonly startTicks: string;
    };
  },
) =>
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 2,
      createdAt: input.createdAt ?? "2026-06-27T00:00:00.000Z",
      repositoryScope: input.repositoryScope ?? input.runScope,
      owner: input.owner ?? { pid: 999, bootId: "boot-test", startTicks: "1" },
      hostProcesses: input.hostProcesses ?? [],
      ...input,
    })}\n`,
  );

const listJsonLedgers = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort();

describe("Linux KVM desktop preflight", () => {
  it("reports the complete GUI and recording substrate as available", async () => {
    const report = vi.fn();
    const availability = await preflightLinuxKvm({
      baseImagePath: "/images/executor-desktop.qcow2",
      runtime: availableRuntime(report),
    });

    expect(availability.status).toBe("available");
    expect(availability.checks).toHaveLength(7);
    expect(availability.capabilities).toBe(LINUX_KVM_DESKTOP_CAPABILITIES);
    expect(report).not.toHaveBeenCalled();
  });

  it("returns and reports an unavailable optional local substrate", async () => {
    const report = vi.fn();
    const availability = await preflightLinuxKvm({
      requirement: "optional",
      runtime: unavailableRuntime(report),
    });

    expect(availability).toMatchObject({
      status: "unavailable",
      capabilities: {
        workload: "desktop-gui",
        display: { interactive: true, protocol: "spice" },
        recording: { container: "mp4", required: true, source: "guest-display" },
      },
    });
    expect(report).toHaveBeenCalledWith(expect.stringContaining("[optional]"));
  });

  it("fails required mode before a VM driver can boot a guest", async () => {
    const report = vi.fn();
    const preflight = preflightLinuxKvm({
      requirement: "required",
      runtime: unavailableRuntime(report),
    });

    await expect(preflight).rejects.toBeInstanceOf(LinuxKvmUnavailableError);
    expect(report).not.toHaveBeenCalled();
  });

  it("gates desktop provisioning on required preflight", async () => {
    const provision = vi.fn(() => failProbe("VM driver must not run"));
    const provider = createLinuxKvmDesktopProvider(
      { provision },
      { runtime: unavailableRuntime() },
    );

    await expect(provider.provision()).rejects.toBeInstanceOf(LinuxKvmUnavailableError);
    expect(provision).not.toHaveBeenCalled();
  });
});

describe("Linux KVM libvirt driver", () => {
  it("registers an opt-in required heavy-VM project", () => {
    expect(projectDefinition("desktop-kvm")).toMatchObject({
      target: "desktop-kvm",
      include: ["desktop-kvm/**/*.test.ts"],
      globalSetup: ["./setup/desktop-kvm.globalsetup.ts"],
      requiredCapabilities: ["desktop-gui"],
      tier: "heavy-vm",
      hermetic: true,
    });
  });

  it("creates a QXL/SPICE domain from disposable overlay and cloud-init disks", () => {
    const args = libvirtDomainArgs({
      domainName: "executor-e2e-desktop-test",
      libvirtNetwork: "default",
      libvirtUri: "qemu:///system",
      memoryMiB: 4_096,
      osVariant: "generic",
      overlayPath: "/tmp/guest.qcow2",
      seedPath: "/tmp/seed.iso",
      vcpus: 4,
    });

    expect(args).toContain("spice,listen=127.0.0.1");
    expect(args).toContain("qxl");
    expect(args).toContain(
      "path=/tmp/guest.qcow2,format=qcow2,bus=virtio,cache=none,discard=unmap",
    );
    expect(args).toContain("path=/tmp/seed.iso,device=cdrom,readonly=on");
  });

  it("seeds an isolated guest user and real Xorg service", () => {
    const cloudInit = linuxKvmCloudInit({
      domainName: "executor-e2e-desktop-test",
      guestDisplay: ":0",
      guestUser: "executor",
      publicKey: "ssh-ed25519 AAAATEST executor-e2e",
    });

    expect(cloudInit.userData).toContain("ssh-ed25519 AAAATEST executor-e2e");
    expect(cloudInit.userData).toContain("executor-e2e-gui.service");
    expect(cloudInit.userData).toContain("/usr/bin/Xorg :0 vt7");
    expect(cloudInit.userData).toContain("-noreset -ac");
    expect(cloudInit.userData).toContain("display-manager.service");
  });

  it("guarantees LIFO discard even when one cleanup action fails", async () => {
    const order: string[] = [];
    const finalizers = createLinuxKvmFinalizerStack();
    finalizers.add("work directory", () => {
      order.push("work-directory");
    });
    finalizers.add("domain", () => {
      order.push("domain");
      return failProbe("domain cleanup");
    });
    finalizers.add("recording", () => {
      order.push("recording");
    });

    await expect(finalizers.run()).rejects.toThrow("Linux KVM cleanup was incomplete");
    expect(order).toEqual(["recording", "domain", "work-directory"]);
    await expect(finalizers.run()).resolves.toBeUndefined();
  });

  it("normalizes one explicit CI run scope for both provisioning and cleanup", () => {
    expect(linuxKvmRunScope({ E2E_KVM_RUN_SCOPE: "Run 123 / Attempt 2 / KVM" })).toBe(
      "run-123-attempt-2-kvm",
    );
    expect(() => linuxKvmRunScope({ E2E_KVM_RUN_SCOPE: "///" })).toThrow("has no safe characters");
  });

  it("cleans only the exact ledger domain and work directory", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "executor-kvm-cleanup-test-"));
    const workDir = join(workRoot, "executor-kvm-exact");
    const ledgerPath = join(workRoot, "cleanup.json");
    const domainName = "executor-e2e-desktop-run-123-99-deadbeef";
    const hostProcess: LinuxKvmCleanupHostProcess = {
      pid: 43_210,
      role: "ffmpeg",
      marker: `executor-e2e-kvm:run-123:${domainName}:ffmpeg`,
    };
    mkdirSync(workDir);
    writeTestCleanupLedger(ledgerPath, {
      runScope: "run-123",
      domainName,
      libvirtUri: "qemu:///system",
      workRoot,
      workDir,
      hostProcesses: [hostProcess],
    });
    const domainExists = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const hostProcessMatches = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const terminateHostProcess = vi.fn(async () => undefined);
    const virsh = vi.fn(async () => undefined);
    const removedDirectories: string[] = [];
    const removedLedgers: string[] = [];
    const runtime = {
      domainExists,
      hostProcessMatches,
      terminateHostProcess,
      virsh,
      removeDirectory: (path: string) => {
        removedDirectories.push(path);
        rmSync(path, { force: true, recursive: true });
      },
      removeLedger: (path: string) => {
        removedLedgers.push(path);
        rmSync(path, { force: true });
      },
    } satisfies LinuxKvmCleanupRuntime;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain test fixture cleanup must run after assertions
    try {
      const cleaned = await cleanupLibvirtLinuxKvmFromLedger(ledgerPath, {
        expectedRepositoryScope: "run-123",
        expectedRunScope: "run-123",
        expectedWorkRoot: workRoot,
        expectedLibvirtUri: "qemu:///system",
        runtime,
      });

      expect(cleaned.domainName).toBe(domainName);
      expect(hostProcessMatches).toHaveBeenNthCalledWith(1, hostProcess.pid, hostProcess.marker);
      expect(hostProcessMatches).toHaveBeenNthCalledWith(2, hostProcess.pid, hostProcess.marker);
      expect(terminateHostProcess).toHaveBeenCalledWith(hostProcess.pid);
      expect(domainExists).toHaveBeenNthCalledWith(1, "qemu:///system", domainName);
      expect(domainExists).toHaveBeenNthCalledWith(2, "qemu:///system", domainName);
      expect(virsh).toHaveBeenNthCalledWith(1, "qemu:///system", ["destroy", domainName]);
      expect(virsh).toHaveBeenNthCalledWith(2, "qemu:///system", [
        "undefine",
        domainName,
        "--nvram",
      ]);
      expect(removedDirectories).toEqual([workDir]);
      expect(removedLedgers).toEqual([ledgerPath]);
      expect(existsSync(workDir)).toBe(false);
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      rmSync(workRoot, { force: true, recursive: true });
    }
  });

  it("refuses a cleanup ledger from any other run scope before touching libvirt", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "executor-kvm-cleanup-scope-test-"));
    const workDir = join(workRoot, "executor-kvm-exact");
    const ledgerPath = join(workRoot, "cleanup.json");
    mkdirSync(workDir);
    writeTestCleanupLedger(ledgerPath, {
      runScope: "run-123",
      domainName: "executor-e2e-desktop-run-123-99-deadbeef",
      libvirtUri: "qemu:///system",
      workRoot,
      workDir,
    });
    const runtime = {
      domainExists: vi.fn(async () => true),
      hostProcessMatches: vi.fn(async () => false),
      terminateHostProcess: vi.fn(async () => undefined),
      virsh: vi.fn(async () => undefined),
      removeDirectory: vi.fn(),
      removeLedger: vi.fn(),
    } satisfies LinuxKvmCleanupRuntime;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain test fixture cleanup must run after assertions
    try {
      await expect(
        cleanupLibvirtLinuxKvmFromLedger(ledgerPath, {
          expectedRepositoryScope: "run-123",
          expectedRunScope: "run-124",
          expectedWorkRoot: workRoot,
          expectedLibvirtUri: "qemu:///system",
          runtime,
        }),
      ).rejects.toThrow("expected run-124");
      expect(runtime.domainExists).not.toHaveBeenCalled();
      expect(runtime.hostProcessMatches).not.toHaveBeenCalled();
      expect(runtime.terminateHostProcess).not.toHaveBeenCalled();
      expect(runtime.virsh).not.toHaveBeenCalled();
      expect(runtime.removeDirectory).not.toHaveBeenCalled();
      expect(runtime.removeLedger).not.toHaveBeenCalled();
      expect(existsSync(ledgerPath)).toBe(true);
      expect(existsSync(workDir)).toBe(true);
    } finally {
      rmSync(workRoot, { force: true, recursive: true });
    }
  });

  it("recovers a partial provision where the ledger exists but no domain was created", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "executor-kvm-partial-test-"));
    const workDir = join(workRoot, "executor-kvm-partial");
    const ledgerPath = join(workRoot, "cleanup.json");
    const domainName = "executor-e2e-desktop-run-partial-99-deadbeef";
    const exitedHostProcess: LinuxKvmCleanupHostProcess = {
      pid: 43_211,
      role: "xvfb",
      marker: `executor-e2e-kvm:run-partial:${domainName}:xvfb`,
    };
    mkdirSync(workDir);
    writeTestCleanupLedger(ledgerPath, {
      runScope: "run-partial",
      domainName,
      libvirtUri: "qemu:///system",
      workRoot,
      workDir,
      hostProcesses: [exitedHostProcess],
    });
    const runtime = {
      domainExists: vi.fn(async () => false),
      hostProcessMatches: vi.fn(async () => false),
      terminateHostProcess: vi.fn(async () => undefined),
      virsh: vi.fn(async () => undefined),
      removeDirectory: (path: string) => rmSync(path, { force: true, recursive: true }),
      removeLedger: (path: string) => rmSync(path, { force: true }),
    } satisfies LinuxKvmCleanupRuntime;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain test fixture cleanup must run after assertions
    try {
      await cleanupLibvirtLinuxKvmFromLedger(ledgerPath, {
        expectedRepositoryScope: "run-partial",
        expectedRunScope: "run-partial",
        expectedWorkRoot: workRoot,
        expectedLibvirtUri: "qemu:///system",
        runtime,
      });
      expect(runtime.domainExists).toHaveBeenCalledWith("qemu:///system", domainName);
      expect(runtime.hostProcessMatches).toHaveBeenCalledWith(
        exitedHostProcess.pid,
        exitedHostProcess.marker,
      );
      expect(runtime.terminateHostProcess).not.toHaveBeenCalled();
      expect(runtime.virsh).not.toHaveBeenCalled();
      expect(existsSync(workDir)).toBe(false);
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      rmSync(workRoot, { force: true, recursive: true });
    }
  });

  it("treats a missing cancellation ledger as an explicit clean no-op", async () => {
    await expect(
      cleanupLinuxKvmLedger({
        ledgerPath: "/tmp/executor-kvm-definitely-missing-ledger.json",
        expectedRepositoryScope: "run-missing",
        expectedRunScope: "run-missing",
        ledgerExists: () => false,
      }),
    ).resolves.toEqual({
      status: "missing",
      ledgerPath: "/tmp/executor-kvm-definitely-missing-ledger.json",
    });
  });
});

describe("Linux KVM stale runner recovery", () => {
  it("requires an explicit repository scope and positive TTL before scanning", () => {
    expect(() =>
      sweepLinuxKvmRepository({
        ledgerDirectory: "/var/tmp/executor-kvm-ledgers/repo-42",
        repositoryScope: undefined,
        staleTtlMs: "21600000",
      }),
    ).toThrow("requires E2E_KVM_REPOSITORY_SCOPE");
    expect(() =>
      sweepLinuxKvmRepository({
        ledgerDirectory: "/var/tmp/executor-kvm-ledgers/repo-42",
        repositoryScope: "repo-42",
        staleTtlMs: "0",
      }),
    ).toThrow("requires a positive E2E_KVM_STALE_TTL_MS");
  });

  it("cleans only an expired dead owner and preserves fresh, active, current, and other repositories", async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-kvm-stale-sweep-test-"));
    const repositoryScope = "repo-42";
    const ledgerDirectory = join(root, repositoryScope);
    const otherLedgerDirectory = join(root, "repo-99");
    const workRoot = join(root, "work");
    mkdirSync(ledgerDirectory);
    mkdirSync(otherLedgerDirectory);
    mkdirSync(workRoot);
    const makeLedger = (input: {
      readonly filename: string;
      readonly runScope: string;
      readonly createdAt: string;
      readonly owner: LinuxKvmOwnerIdentity;
      readonly hostProcess?: LinuxKvmCleanupHostProcess;
    }) => {
      const ledgerPath = join(ledgerDirectory, input.filename);
      const workDir = join(workRoot, `executor-kvm-${input.runScope}`);
      const domainName = `executor-e2e-desktop-${input.runScope}-99-deadbeef`;
      mkdirSync(workDir);
      writeTestCleanupLedger(ledgerPath, {
        repositoryScope,
        runScope: input.runScope,
        createdAt: input.createdAt,
        owner: input.owner,
        domainName,
        libvirtUri: "qemu:///system",
        workRoot,
        workDir,
        hostProcesses: input.hostProcess ? [input.hostProcess] : [],
      });
      return { ledgerPath, workDir, domainName };
    };
    const staleRunScope = `${repositoryScope}-run-stale`;
    const staleDomain = `executor-e2e-desktop-${staleRunScope}-99-deadbeef`;
    const staleHostProcess: LinuxKvmCleanupHostProcess = {
      pid: 70_001,
      role: "ffmpeg",
      marker: `executor-e2e-kvm:${staleRunScope}:${staleDomain}:ffmpeg`,
    };
    const stale = makeLedger({
      filename: "01-stale.json",
      runScope: staleRunScope,
      createdAt: "2026-06-27T06:00:00.000Z",
      owner: { pid: 101, bootId: "boot-old", startTicks: "10" },
      hostProcess: staleHostProcess,
    });
    const fresh = makeLedger({
      filename: "02-fresh.json",
      runScope: `${repositoryScope}-run-fresh`,
      createdAt: "2026-06-27T10:00:00.000Z",
      owner: { pid: 102, bootId: "boot-old", startTicks: "20" },
    });
    const active = makeLedger({
      filename: "03-active.json",
      runScope: `${repositoryScope}-run-active`,
      createdAt: "2026-06-27T00:00:00.000Z",
      owner: { pid: 103, bootId: "boot-current", startTicks: "30" },
    });
    const current = makeLedger({
      filename: "04-current.json",
      runScope: `${repositoryScope}-run-current`,
      createdAt: "2026-06-27T00:00:00.000Z",
      owner: { pid: 104, bootId: "boot-old", startTicks: "40" },
    });
    const otherWorkDir = join(workRoot, "executor-kvm-other-repository");
    const otherLedgerPath = join(otherLedgerDirectory, "01-other.json");
    mkdirSync(otherWorkDir);
    writeTestCleanupLedger(otherLedgerPath, {
      repositoryScope: "repo-99",
      runScope: "repo-99-run-old",
      createdAt: "2026-06-27T00:00:00.000Z",
      owner: { pid: 105, bootId: "boot-old", startTicks: "50" },
      domainName: "executor-e2e-desktop-repo-99-run-old-99-deadbeef",
      libvirtUri: "qemu:///system",
      workRoot,
      workDir: otherWorkDir,
    });
    const ownerStatus = vi.fn((owner: LinuxKvmOwnerIdentity) =>
      owner.pid === 103 ? ("alive" as const) : ("dead" as const),
    );
    const sweepRuntime = {
      now: () => Date.parse("2026-06-27T12:00:00.000Z"),
      listLedgerPaths: listJsonLedgers,
      ownerStatus,
    } satisfies LinuxKvmStaleSweepRuntime;
    const cleanupRuntime = {
      domainExists: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      hostProcessMatches: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      terminateHostProcess: vi.fn(async () => undefined),
      virsh: vi.fn(async () => undefined),
      removeDirectory: (path: string) => rmSync(path, { force: true, recursive: true }),
      removeLedger: (path: string) => rmSync(path, { force: true }),
    } satisfies LinuxKvmCleanupRuntime;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain test fixture cleanup must run after assertions
    try {
      const result = await sweepStaleLibvirtLinuxKvm({
        ledgerDirectory,
        repositoryScope,
        ttlMs: 6 * 60 * 60 * 1_000,
        currentLedgerPath: current.ledgerPath,
        expectedWorkRoot: workRoot,
        expectedLibvirtUri: "qemu:///system",
        runtime: sweepRuntime,
        cleanupRuntime,
      });

      expect(result).toEqual({
        scanned: 4,
        cleaned: [stale.ledgerPath],
        preservedCurrent: [current.ledgerPath],
        preservedFresh: [fresh.ledgerPath],
        preservedActive: [active.ledgerPath],
      });
      expect(cleanupRuntime.hostProcessMatches).toHaveBeenNthCalledWith(
        1,
        staleHostProcess.pid,
        staleHostProcess.marker,
      );
      expect(cleanupRuntime.hostProcessMatches).toHaveBeenNthCalledWith(
        2,
        staleHostProcess.pid,
        staleHostProcess.marker,
      );
      expect(cleanupRuntime.terminateHostProcess).toHaveBeenCalledWith(staleHostProcess.pid);
      expect(cleanupRuntime.virsh).toHaveBeenCalledWith("qemu:///system", [
        "destroy",
        stale.domainName,
      ]);
      expect(existsSync(stale.ledgerPath)).toBe(false);
      expect(existsSync(stale.workDir)).toBe(false);
      expect(existsSync(fresh.ledgerPath)).toBe(true);
      expect(existsSync(fresh.workDir)).toBe(true);
      expect(existsSync(active.ledgerPath)).toBe(true);
      expect(existsSync(active.workDir)).toBe(true);
      expect(existsSync(current.ledgerPath)).toBe(true);
      expect(existsSync(current.workDir)).toBe(true);
      expect(existsSync(otherLedgerPath)).toBe(true);
      expect(existsSync(otherWorkDir)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("validates every repository ledger before cleaning any stale resource", async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-kvm-stale-malformed-test-"));
    const repositoryScope = "repo-42";
    const ledgerDirectory = join(root, repositoryScope);
    const workRoot = join(root, "work");
    const workDir = join(workRoot, "executor-kvm-valid");
    const validLedgerPath = join(ledgerDirectory, "01-valid.json");
    mkdirSync(ledgerDirectory);
    mkdirSync(workDir, { recursive: true });
    writeTestCleanupLedger(validLedgerPath, {
      repositoryScope,
      runScope: `${repositoryScope}-run-valid`,
      createdAt: "2026-06-27T00:00:00.000Z",
      owner: { pid: 201, bootId: "boot-old", startTicks: "10" },
      domainName: `executor-e2e-desktop-${repositoryScope}-run-valid-99-deadbeef`,
      libvirtUri: "qemu:///system",
      workRoot,
      workDir,
    });
    const invalidLedgerPath = join(ledgerDirectory, "02-invalid.json");
    writeFileSync(invalidLedgerPath, "{\n");
    const cleanupRuntime = {
      domainExists: vi.fn(async () => false),
      hostProcessMatches: vi.fn(async () => false),
      terminateHostProcess: vi.fn(async () => undefined),
      virsh: vi.fn(async () => undefined),
      removeDirectory: vi.fn(),
      removeLedger: vi.fn(),
    } satisfies LinuxKvmCleanupRuntime;
    const sweep = () =>
      sweepStaleLibvirtLinuxKvm({
        ledgerDirectory,
        repositoryScope,
        ttlMs: 1,
        expectedWorkRoot: workRoot,
        expectedLibvirtUri: "qemu:///system",
        runtime: {
          now: () => Date.parse("2026-06-27T12:00:00.000Z"),
          listLedgerPaths: listJsonLedgers,
          ownerStatus: () => "dead",
        },
        cleanupRuntime,
      });

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain test fixture cleanup must run after assertions
    try {
      await expect(sweep()).rejects.toThrow();
      expect(cleanupRuntime.domainExists).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeDirectory).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeLedger).not.toHaveBeenCalled();
      expect(existsSync(validLedgerPath)).toBe(true);
      expect(existsSync(workDir)).toBe(true);

      writeFileSync(invalidLedgerPath, '{"version":999}\n');
      await expect(sweep()).rejects.toThrow("invalid Linux KVM cleanup ledger");
      expect(cleanupRuntime.domainExists).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeDirectory).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeLedger).not.toHaveBeenCalled();
      expect(existsSync(validLedgerPath)).toBe(true);
      expect(existsSync(workDir)).toBe(true);

      writeFileSync(
        invalidLedgerPath,
        `${JSON.stringify({
          version: 2,
          createdAt: "2026-06-27T00:00:00.000Z",
          repositoryScope,
          runScope: `${repositoryScope}-run-incomplete`,
          domainName: `executor-e2e-desktop-${repositoryScope}-run-incomplete-99-deadbeef`,
          libvirtUri: "qemu:///system",
          workRoot,
          workDir: join(workRoot, "executor-kvm-incomplete"),
          owner: { pid: 202, bootId: "boot-old", startTicks: "20" },
        })}\n`,
      );
      await expect(sweep()).rejects.toThrow("invalid Linux KVM host process ledger");
      expect(cleanupRuntime.domainExists).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeDirectory).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeLedger).not.toHaveBeenCalled();
      expect(existsSync(validLedgerPath)).toBe(true);
      expect(existsSync(workDir)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails safe when an expired ledger owner cannot be classified", async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-kvm-owner-unknown-test-"));
    const repositoryScope = "repo-42";
    const ledgerDirectory = join(root, repositoryScope);
    const workRoot = join(root, "work");
    const workDir = join(workRoot, "executor-kvm-owner-unknown");
    const ledgerPath = join(ledgerDirectory, "01-owner-unknown.json");
    mkdirSync(ledgerDirectory);
    mkdirSync(workDir, { recursive: true });
    writeTestCleanupLedger(ledgerPath, {
      repositoryScope,
      runScope: `${repositoryScope}-run-owner-unknown`,
      createdAt: "2026-06-27T00:00:00.000Z",
      owner: { pid: 301, bootId: "boot-old", startTicks: "10" },
      domainName: `executor-e2e-desktop-${repositoryScope}-run-owner-unknown-99-deadbeef`,
      libvirtUri: "qemu:///system",
      workRoot,
      workDir,
    });
    const cleanupRuntime = {
      domainExists: vi.fn(async () => false),
      hostProcessMatches: vi.fn(async () => false),
      terminateHostProcess: vi.fn(async () => undefined),
      virsh: vi.fn(async () => undefined),
      removeDirectory: vi.fn(),
      removeLedger: vi.fn(),
    } satisfies LinuxKvmCleanupRuntime;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: plain test fixture cleanup must run after assertions
    try {
      await expect(
        sweepStaleLibvirtLinuxKvm({
          ledgerDirectory,
          repositoryScope,
          ttlMs: 1,
          expectedWorkRoot: workRoot,
          expectedLibvirtUri: "qemu:///system",
          runtime: {
            now: () => Date.parse("2026-06-27T12:00:00.000Z"),
            listLedgerPaths: listJsonLedgers,
            ownerStatus: () => "unknown",
          },
          cleanupRuntime,
        }),
      ).rejects.toThrow("owner status is unknown");
      expect(cleanupRuntime.domainExists).not.toHaveBeenCalled();
      expect(cleanupRuntime.removeDirectory).not.toHaveBeenCalled();
      expect(existsSync(ledgerPath)).toBe(true);
      expect(existsSync(workDir)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("treats a reused PID as dead unless boot and start identities also match", () => {
    const self = linuxKvmOwnerIdentity();
    expect(linuxKvmOwnerStatus(self)).toBe("alive");
    expect(linuxKvmOwnerStatus({ ...self, startTicks: `${self.startTicks}0` })).toBe("dead");
    expect(linuxKvmOwnerStatus({ ...self, bootId: `${self.bootId}-previous` })).toBe("dead");
    const expected = { pid: 401, bootId: "boot-a", startTicks: "10" };
    expect(linuxKvmOwnerIdentityMatches(expected, expected)).toBe(true);
    expect(linuxKvmOwnerIdentityMatches(expected, { ...expected, startTicks: "11" })).toBe(false);
    expect(linuxKvmOwnerIdentityMatches(expected, { ...expected, bootId: "boot-b" })).toBe(false);
  });
});

describe("Linux KVM guest acceptance payload", () => {
  it("serves bearer-isolated account catalogs from one origin", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "executor-kvm-account-fixture-test-"));
    const ledgerPath = join(stateDir, "account-ledger.json");
    const server = createKvmAccountFixture(ledgerPath);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: node:http test fixture must close after assertions
    try {
      const port = await listenOnLoopback(server);
      const origin = `http://127.0.0.1:${port}`;
      const [accountA, accountB] = KVM_ACCOUNT_FIXTURES;
      const request = (token: string) =>
        fetch(`${origin}/api/integrations`, {
          headers: { authorization: `Bearer ${token}` },
        });
      const responseA = await request(accountA.token);
      const responseB = await request(accountB.token);
      const rejected = await request("not-an-account");

      expect(responseA.status).toBe(200);
      expect(await responseA.json()).toEqual([
        expect.objectContaining({ slug: accountA.slug, name: accountA.marker }),
      ]);
      expect(responseB.status).toBe(200);
      expect(await responseB.json()).toEqual([
        expect.objectContaining({ slug: accountB.slug, name: accountB.marker }),
      ]);
      expect(rejected.status).toBe(401);
      expect(readFileSync(ledgerPath, "utf8")).toContain(`Bearer ${accountA.token}`);
      expect(readFileSync(ledgerPath, "utf8")).toContain(`Bearer ${accountB.token}`);
    } finally {
      await closeServer(server);
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("drives execute discovery and returns its tool result through loopback replay", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "executor-kvm-replay-test-"));
    const ledgerPath = join(stateDir, "replay-ledger.json");
    const server = createKvmReplayBrain(ledgerPath);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: node:http test fixture must close after assertions
    try {
      const port = await listenOnLoopback(server);
      const origin = `http://127.0.0.1:${port}`;
      const first = await fetch(`${origin}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "replay-model",
          stream: true,
          tools: [{ name: "mcp__executor__execute" }],
          messages: [{ role: "user", content: "calculate six times seven" }],
        }),
      });
      const firstTranscript = await first.text();
      expect(firstTranscript).toContain("mcp__executor__execute");
      expect(firstTranscript).toContain(KVM_CLAUDE_EXECUTE_CODE);

      const second = await fetch(`${origin}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "replay-model",
          stream: true,
          tools: [{ name: "mcp__executor__execute" }],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_kvm_replay_0",
                  content: "42",
                },
              ],
            },
          ],
        }),
      });
      expect(await second.text()).toContain("executor-result:42");
      expect(readFileSync(ledgerPath, "utf8")).toContain("mcp__executor__execute");
      expect(readFileSync(ledgerPath, "utf8")).toContain('"content": "42"');
    } finally {
      await closeServer(server);
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("refuses any paid-inference or non-local MCP boundary before starting Claude", async () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:4000")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:4000/mcp")).toBe(true);
    expect(isLoopbackHttpUrl("https://api.anthropic.com")).toBe(false);
    expect(isLoopbackHttpUrl("http://192.0.2.1:4000/mcp")).toBe(false);

    await expect(
      runKvmGuestClaude({
        binaryPath: "/never/invoked/claude",
        expectedVersion: "2.1.195",
        homeDir: "/never/created/home",
        mcpUrl: "http://127.0.0.1:3000/mcp",
        authorizationHeader: "Bearer synthetic",
        brainBaseUrl: "https://api.anthropic.com",
        outputPath: "/never/created/result.json",
      }),
    ).rejects.toThrow("refusing non-loopback Anthropic replay URL");
    expect(existsSync("/never/created/home")).toBe(false);
  });
});
