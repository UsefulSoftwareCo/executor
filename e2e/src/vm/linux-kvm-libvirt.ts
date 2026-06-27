// Concrete libvirt/QEMU implementation of the Linux desktop VM contract.
// The base image is a prepared x86_64 Linux desktop image with cloud-init,
// Xorg, xinit, openbox, xdpyinfo, xdotool, SSH, and Electron runtime libraries. Each run
// uses a disposable QCOW2 overlay and a unique cloud-init identity.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  createLinuxKvmDesktopProvider,
  type LinuxKvmDesktopDriver,
  type LinuxKvmDesktopHandle,
  type LinuxKvmDisplayRecording,
  type LinuxKvmGuestConnection,
  type LinuxKvmGuestCommandResult,
  type LinuxKvmPreflightRuntime,
  type LinuxKvmToolchain,
  resolveLinuxKvmToolchain,
} from "./linux-kvm";

const execFileP = promisify(execFile);

const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "LogLevel=ERROR",
] as const;

type AsyncFinalizer = () => Promise<void> | void;

export const createLinuxKvmFinalizerStack = () => {
  const finalizers: Array<{ readonly label: string; readonly run: AsyncFinalizer }> = [];
  let finished = false;

  const add = (label: string, run: AsyncFinalizer) => {
    if (finished) throw new Error(`cannot register ${label} after Linux KVM cleanup`);
    finalizers.push({ label, run });
  };

  const run = async () => {
    if (finished) return;
    finished = true;
    const failures: unknown[] = [];
    for (const finalizer of finalizers.reverse()) {
      try {
        await finalizer.run();
      } catch (error) {
        failures.push(new AggregateError([error], `Linux KVM cleanup failed: ${finalizer.label}`));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Linux KVM cleanup was incomplete");
    }
  };

  return { add, run };
};

export interface LibvirtDomainArgsOptions {
  readonly domainName: string;
  readonly libvirtNetwork: string;
  readonly libvirtUri: string;
  readonly memoryMiB: number;
  readonly osVariant: string;
  readonly overlayPath: string;
  readonly seedPath: string;
  readonly vcpus: number;
}

export const libvirtDomainArgs = (options: LibvirtDomainArgsOptions) => [
  "--connect",
  options.libvirtUri,
  "--name",
  options.domainName,
  "--memory",
  String(options.memoryMiB),
  "--vcpus",
  String(options.vcpus),
  "--cpu",
  "host-passthrough",
  "--import",
  "--noautoconsole",
  "--boot",
  "hd",
  "--disk",
  `path=${options.overlayPath},format=qcow2,bus=virtio,cache=none,discard=unmap`,
  "--disk",
  `path=${options.seedPath},device=cdrom,readonly=on`,
  "--network",
  `network=${options.libvirtNetwork},model=virtio`,
  "--graphics",
  "spice,listen=127.0.0.1",
  "--video",
  "qxl",
  "--channel",
  "spicevmc",
  "--rng",
  "/dev/urandom",
  "--os-variant",
  options.osVariant,
];

export const linuxKvmCloudInit = (options: {
  readonly domainName: string;
  readonly guestDisplay: string;
  readonly guestUser: string;
  readonly publicKey: string;
}) => {
  if (!/^[a-z_][a-z0-9_-]*$/.test(options.guestUser)) {
    throw new Error(`invalid Linux KVM guest user: ${options.guestUser}`);
  }
  if (options.publicKey.includes("\n")) throw new Error("SSH public key must be one line");

  const userData = `#cloud-config
hostname: ${options.domainName}
manage_etc_hosts: true
ssh_pwauth: false
disable_root: true
users:
  - name: ${options.guestUser}
    groups: [adm, sudo, video, render]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${options.publicKey}
write_files:
  - path: /etc/X11/Xwrapper.config
    permissions: "0644"
    content: |
      allowed_users=anybody
      needs_root_rights=yes
  - path: /usr/local/bin/executor-e2e-session
    permissions: "0755"
    content: |
      #!/bin/sh
      exec /usr/bin/dbus-run-session -- /usr/bin/openbox-session
  - path: /etc/systemd/system/executor-e2e-gui.service
    permissions: "0644"
    content: |
      [Unit]
      Description=Executor E2E graphical session
      After=systemd-user-sessions.service
      Conflicts=display-manager.service

      [Service]
      Type=simple
      User=${options.guestUser}
      Group=${options.guestUser}
      PAMName=login
      TTYPath=/dev/tty7
      StandardInput=tty-force
      Environment=HOME=/home/${options.guestUser}
      Environment=DISPLAY=${options.guestDisplay}
      WorkingDirectory=/home/${options.guestUser}
      ExecStart=/usr/bin/xinit /usr/local/bin/executor-e2e-session -- /usr/bin/Xorg ${options.guestDisplay} vt7 -keeptty -nolisten tcp -noreset -ac
      Restart=on-failure
      RestartSec=2

      [Install]
      WantedBy=multi-user.target
runcmd:
  - [sh, -c, "systemctl disable --now display-manager.service 2>/dev/null || true"]
  - [systemctl, daemon-reload]
  - [systemctl, enable, executor-e2e-gui.service]
  - [systemctl, start, --no-block, executor-e2e-gui.service]
`;
  const metaData = `instance-id: ${options.domainName}
local-hostname: ${options.domainName}
`;
  return { metaData, userData };
};

export interface LibvirtLinuxKvmOptions {
  readonly baseImagePath: string;
  readonly baseImageFormat?: string;
  readonly cleanupLedgerPath?: string;
  readonly guestDisplay?: string;
  readonly guestUser?: string;
  readonly libvirtNetwork?: string;
  readonly libvirtUri?: string;
  readonly memoryMiB?: number;
  readonly osVariant?: string;
  readonly recordingFrameRate?: number;
  readonly recordingSize?: string;
  readonly repositoryScope?: string;
  readonly runScope?: string;
  readonly toolchain?: Partial<LinuxKvmToolchain>;
  readonly vcpus?: number;
  readonly workRoot?: string;
  readonly preflightRuntime?: LinuxKvmPreflightRuntime;
}

export interface LinuxKvmCleanupLedger {
  readonly version: 2;
  readonly createdAt: string;
  readonly repositoryScope: string;
  readonly runScope: string;
  readonly domainName: string;
  readonly libvirtUri: string;
  readonly workRoot: string;
  readonly workDir: string;
  readonly hostProcesses: ReadonlyArray<LinuxKvmCleanupHostProcess>;
  readonly owner: LinuxKvmOwnerIdentity;
}

export interface LinuxKvmOwnerIdentity {
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: string;
}

export interface LinuxKvmCleanupHostProcess {
  readonly pid: number;
  readonly role: "xvfb" | "openbox" | "remote-viewer" | "ffmpeg" | "ssh-forward";
  readonly marker: string;
}

export interface LinuxKvmCleanupRuntime {
  domainExists(libvirtUri: string, domainName: string): Promise<boolean>;
  hostProcessMatches(pid: number, marker: string): Promise<boolean>;
  terminateHostProcess(pid: number): Promise<void>;
  virsh(libvirtUri: string, args: ReadonlyArray<string>): Promise<void>;
  removeDirectory(path: string): void;
  removeLedger(path: string): void;
}

const safeRunScope = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const requiredSafeScope = (value: string, label: string) => {
  const normalized = safeRunScope(value);
  if (!normalized) throw new Error(`${label} has no safe characters`);
  return normalized;
};

export const linuxKvmRunScope = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const explicit = environment.E2E_KVM_RUN_SCOPE;
  if (explicit) {
    return requiredSafeScope(explicit, "E2E_KVM_RUN_SCOPE");
  }
  const githubScope = [
    environment.GITHUB_RUN_ID,
    environment.GITHUB_RUN_ATTEMPT,
    environment.GITHUB_JOB,
  ]
    .filter((value): value is string => Boolean(value))
    .join("-");
  return safeRunScope(githubScope || `local-${process.pid}`);
};

export const linuxKvmRepositoryScope = (
  runScope: string,
  value = process.env.E2E_KVM_REPOSITORY_SCOPE,
) => requiredSafeScope(value || runScope, "E2E_KVM_REPOSITORY_SCOPE");

const ensureRepositoryLedgerDirectory = (directory: string, repositoryScope: string) => {
  if (basename(directory) !== repositoryScope) {
    throw new Error(
      `Linux KVM ledger directory must end in repository scope ${repositoryScope}: ${directory}`,
    );
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Linux KVM ledger directory is not a real directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
};

const writeCleanupLedger = (path: string, ledger: LinuxKvmCleanupLedger) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const processStartTicks = (stat: string) => {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Linux process stat did not contain a command boundary");
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Linux process stat did not contain start ticks");
  }
  return startTicks;
};

export const linuxKvmOwnerIdentity = (pid = process.pid): LinuxKvmOwnerIdentity => {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!bootId) throw new Error("Linux boot identity is unavailable");
  return {
    pid,
    bootId,
    startTicks: processStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8")),
  };
};

export const linuxKvmOwnerIdentityMatches = (
  expected: LinuxKvmOwnerIdentity,
  observed: LinuxKvmOwnerIdentity,
) =>
  expected.pid === observed.pid &&
  expected.bootId === observed.bootId &&
  expected.startTicks === observed.startTicks;

export type LinuxKvmOwnerStatus = "alive" | "dead" | "unknown";

export const linuxKvmOwnerStatus = (owner: LinuxKvmOwnerIdentity): LinuxKvmOwnerStatus => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: /proc distinguishes dead owners from unreadable liveness state
  try {
    return linuxKvmOwnerIdentityMatches(owner, linuxKvmOwnerIdentity(owner.pid)) ? "alive" : "dead";
  } catch (cause) {
    return isUnknownRecord(cause) && cause.code === "ENOENT" ? "dead" : "unknown";
  }
};

const isLinuxKvmHostProcessRole = (value: unknown): value is LinuxKvmCleanupHostProcess["role"] =>
  value === "xvfb" ||
  value === "openbox" ||
  value === "remote-viewer" ||
  value === "ffmpeg" ||
  value === "ssh-forward";

export const readLinuxKvmCleanupLedger = (path: string): LinuxKvmCleanupLedger => {
  const ledgerStat = lstatSync(path);
  if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink()) {
    throw new Error(`Linux KVM cleanup ledger is not a real file: ${path}`);
  }
  const decoded: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isUnknownRecord(decoded) ||
    decoded.version !== 2 ||
    typeof decoded.createdAt !== "string" ||
    typeof decoded.repositoryScope !== "string" ||
    typeof decoded.runScope !== "string" ||
    typeof decoded.domainName !== "string" ||
    typeof decoded.libvirtUri !== "string" ||
    typeof decoded.workRoot !== "string" ||
    typeof decoded.workDir !== "string" ||
    !isUnknownRecord(decoded.owner) ||
    typeof decoded.owner.pid !== "number" ||
    !Number.isSafeInteger(decoded.owner.pid) ||
    decoded.owner.pid <= 0 ||
    typeof decoded.owner.bootId !== "string" ||
    decoded.owner.bootId.length === 0 ||
    typeof decoded.owner.startTicks !== "string" ||
    !/^\d+$/.test(decoded.owner.startTicks)
  ) {
    throw new Error(`invalid Linux KVM cleanup ledger: ${path}`);
  }
  const workRoot = resolve(decoded.workRoot);
  const workDir = resolve(decoded.workDir);
  const createdAtMs = Date.parse(decoded.createdAt);
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== decoded.createdAt) {
    throw new Error(`invalid Linux KVM cleanup timestamp: ${decoded.createdAt}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(decoded.repositoryScope)) {
    throw new Error(`invalid Linux KVM repository scope: ${decoded.repositoryScope}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(decoded.runScope)) {
    throw new Error(`invalid Linux KVM cleanup scope: ${decoded.runScope}`);
  }
  if (
    decoded.runScope !== decoded.repositoryScope &&
    !decoded.runScope.startsWith(`${decoded.repositoryScope}-`)
  ) {
    throw new Error(
      `cleanup ledger run scope is outside repository ${decoded.repositoryScope}: ${decoded.runScope}`,
    );
  }
  if (!decoded.domainName.startsWith(`executor-e2e-desktop-${decoded.runScope}-`)) {
    throw new Error(`cleanup ledger domain is outside its run scope: ${decoded.domainName}`);
  }
  if (dirname(workDir) !== workRoot || !basename(workDir).startsWith("executor-kvm-")) {
    throw new Error(`cleanup ledger work directory is outside its root: ${workDir}`);
  }
  if (!Array.isArray(decoded.hostProcesses)) {
    throw new Error(`invalid Linux KVM host process ledger: ${path}`);
  }
  const hostProcesses = decoded.hostProcesses.map((processEntry) => {
    if (
      !isUnknownRecord(processEntry) ||
      typeof processEntry.pid !== "number" ||
      !Number.isSafeInteger(processEntry.pid) ||
      processEntry.pid <= 0 ||
      !isLinuxKvmHostProcessRole(processEntry.role) ||
      typeof processEntry.marker !== "string" ||
      processEntry.marker !==
        `executor-e2e-kvm:${decoded.runScope}:${decoded.domainName}:${processEntry.role}`
    ) {
      throw new Error(`invalid Linux KVM host process entry: ${path}`);
    }
    return {
      pid: processEntry.pid,
      role: processEntry.role,
      marker: processEntry.marker,
    };
  });
  return {
    version: 2,
    createdAt: decoded.createdAt,
    repositoryScope: decoded.repositoryScope,
    runScope: decoded.runScope,
    domainName: decoded.domainName,
    libvirtUri: decoded.libvirtUri,
    workRoot,
    workDir,
    hostProcesses,
    owner: {
      pid: decoded.owner.pid,
      bootId: decoded.owner.bootId,
      startTicks: decoded.owner.startTicks,
    },
  };
};

const processIsRunning = (pid: number) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: POSIX process existence is exposed through throwing process.kill
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signalProcess = (pid: number, signal: NodeJS.Signals) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: POSIX signals race with natural child-process exit
  try {
    process.kill(pid, signal);
    return true;
  } catch (cause) {
    if (isUnknownRecord(cause) && cause.code === "ESRCH") return false;
    throw cause;
  }
};

const defaultCleanupRuntime: LinuxKvmCleanupRuntime = {
  domainExists: async (libvirtUri, domainName) => {
    const { stdout } = await execFileP(resolveLinuxKvmToolchain().virsh, [
      "--connect",
      libvirtUri,
      "list",
      "--all",
      "--name",
    ]);
    return stdout.split(/\r?\n/).includes(domainName);
  },
  hostProcessMatches: async (pid, marker) => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: /proc entries disappear asynchronously when recorded child processes exit
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .includes(`E2E_KVM_PROCESS_MARKER=${marker}`);
    } catch (cause) {
      if (isUnknownRecord(cause) && cause.code === "ENOENT") return false;
      throw cause;
    }
  },
  terminateHostProcess: async (pid) => {
    if (!processIsRunning(pid)) return;
    if (!signalProcess(pid, "SIGTERM")) return;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!processIsRunning(pid)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    signalProcess(pid, "SIGKILL");
  },
  virsh: async (libvirtUri, args) => {
    await execFileP(resolveLinuxKvmToolchain().virsh, ["--connect", libvirtUri, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  },
  removeDirectory: (path) => rmSync(path, { force: true, recursive: true }),
  removeLedger: (path) => rmSync(path, { force: true }),
};

export const cleanupLibvirtLinuxKvmFromLedger = async (
  ledgerPath: string,
  options: {
    readonly expectedLibvirtUri?: string;
    readonly expectedRepositoryScope?: string;
    readonly expectedRunScope?: string;
    readonly expectedWorkRoot?: string;
    readonly runtime?: LinuxKvmCleanupRuntime;
  } = {},
) => {
  const ledger = readLinuxKvmCleanupLedger(ledgerPath);
  const expectedRepositoryScope = options.expectedRepositoryScope
    ? requiredSafeScope(options.expectedRepositoryScope, "expected repository scope")
    : undefined;
  if (expectedRepositoryScope && ledger.repositoryScope !== expectedRepositoryScope) {
    throw new Error(
      `refusing Linux KVM cleanup for repository ${ledger.repositoryScope}; expected ${expectedRepositoryScope}`,
    );
  }
  const expectedRunScope = options.expectedRunScope
    ? linuxKvmRunScope({ E2E_KVM_RUN_SCOPE: options.expectedRunScope })
    : undefined;
  if (expectedRunScope && ledger.runScope !== expectedRunScope) {
    throw new Error(
      `refusing Linux KVM cleanup for scope ${ledger.runScope}; expected ${expectedRunScope}`,
    );
  }
  const expectedWorkRoot = options.expectedWorkRoot ? resolve(options.expectedWorkRoot) : undefined;
  if (expectedWorkRoot && ledger.workRoot !== expectedWorkRoot) {
    throw new Error(
      `refusing Linux KVM cleanup for work root ${ledger.workRoot}; expected ${expectedWorkRoot}`,
    );
  }
  if (options.expectedLibvirtUri && ledger.libvirtUri !== options.expectedLibvirtUri) {
    throw new Error(
      `refusing Linux KVM cleanup for libvirt URI ${ledger.libvirtUri}; expected ${options.expectedLibvirtUri}`,
    );
  }
  const runtime = options.runtime ?? defaultCleanupRuntime;
  for (const hostProcess of ledger.hostProcesses) {
    if (await runtime.hostProcessMatches(hostProcess.pid, hostProcess.marker)) {
      await runtime.terminateHostProcess(hostProcess.pid);
      if (await runtime.hostProcessMatches(hostProcess.pid, hostProcess.marker)) {
        throw new Error(
          `host process survived Linux KVM cleanup: ${hostProcess.role} pid=${hostProcess.pid}`,
        );
      }
    }
  }
  if (await runtime.domainExists(ledger.libvirtUri, ledger.domainName)) {
    await runtime.virsh(ledger.libvirtUri, ["destroy", ledger.domainName]).catch(() => undefined);
    try {
      await runtime.virsh(ledger.libvirtUri, ["undefine", ledger.domainName, "--nvram"]);
    } catch {
      await runtime.virsh(ledger.libvirtUri, ["undefine", ledger.domainName]);
    }
    if (await runtime.domainExists(ledger.libvirtUri, ledger.domainName)) {
      throw new Error(`libvirt domain survived cleanup: ${ledger.domainName}`);
    }
  }
  runtime.removeDirectory(ledger.workDir);
  runtime.removeLedger(ledgerPath);
  return ledger;
};

export interface LinuxKvmStaleSweepRuntime {
  now(): number;
  listLedgerPaths(directory: string): ReadonlyArray<string>;
  ownerStatus(owner: LinuxKvmOwnerIdentity): LinuxKvmOwnerStatus;
}

const defaultStaleSweepRuntime: LinuxKvmStaleSweepRuntime = {
  now: () => Date.now(),
  listLedgerPaths: (directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => {
        if (!entry.isFile()) {
          throw new Error(`refusing non-file Linux KVM cleanup ledger: ${entry.name}`);
        }
        return join(directory, entry.name);
      })
      .sort(),
  ownerStatus: linuxKvmOwnerStatus,
};

export const sweepStaleLibvirtLinuxKvm = async (options: {
  readonly ledgerDirectory: string;
  readonly repositoryScope: string;
  readonly ttlMs: number;
  readonly currentLedgerPath?: string;
  readonly expectedWorkRoot: string;
  readonly expectedLibvirtUri: string;
  readonly runtime?: LinuxKvmStaleSweepRuntime;
  readonly cleanupRuntime?: LinuxKvmCleanupRuntime;
}) => {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error(`Linux KVM stale TTL must be a positive integer: ${options.ttlMs}`);
  }
  const repositoryScope = requiredSafeScope(options.repositoryScope, "Linux KVM repository scope");
  const ledgerDirectory = resolve(options.ledgerDirectory);
  if (basename(ledgerDirectory) !== repositoryScope) {
    throw new Error(
      `Linux KVM ledger directory must end in repository scope ${repositoryScope}: ${ledgerDirectory}`,
    );
  }
  ensureRepositoryLedgerDirectory(ledgerDirectory, repositoryScope);
  const currentLedgerPath = options.currentLedgerPath
    ? resolve(options.currentLedgerPath)
    : undefined;
  if (currentLedgerPath && dirname(currentLedgerPath) !== ledgerDirectory) {
    throw new Error(`current Linux KVM ledger is outside ${ledgerDirectory}: ${currentLedgerPath}`);
  }
  const expectedWorkRoot = resolve(options.expectedWorkRoot);
  const runtime = options.runtime ?? defaultStaleSweepRuntime;
  const now = runtime.now();
  if (!Number.isFinite(now)) throw new Error("Linux KVM stale sweep clock is invalid");

  const inspected = runtime.listLedgerPaths(ledgerDirectory).map((candidatePath) => {
    const ledgerPath = resolve(candidatePath);
    if (dirname(ledgerPath) !== ledgerDirectory) {
      throw new Error(`Linux KVM stale sweep candidate escaped its directory: ${ledgerPath}`);
    }
    const ledger = readLinuxKvmCleanupLedger(ledgerPath);
    if (ledger.repositoryScope !== repositoryScope) {
      throw new Error(
        `Linux KVM stale ledger belongs to repository ${ledger.repositoryScope}, not ${repositoryScope}: ${ledgerPath}`,
      );
    }
    if (ledger.workRoot !== expectedWorkRoot) {
      throw new Error(
        `Linux KVM stale ledger uses work root ${ledger.workRoot}, not ${expectedWorkRoot}: ${ledgerPath}`,
      );
    }
    if (ledger.libvirtUri !== options.expectedLibvirtUri) {
      throw new Error(
        `Linux KVM stale ledger uses libvirt URI ${ledger.libvirtUri}, not ${options.expectedLibvirtUri}: ${ledgerPath}`,
      );
    }
    const ageMs = now - Date.parse(ledger.createdAt);
    if (ledgerPath === currentLedgerPath)
      return { disposition: "current" as const, ledgerPath, ledger };
    if (ageMs < options.ttlMs) return { disposition: "fresh" as const, ledgerPath, ledger };
    const ownerStatus = runtime.ownerStatus(ledger.owner);
    if (ownerStatus === "unknown") {
      throw new Error(`Linux KVM stale ledger owner status is unknown: ${ledgerPath}`);
    }
    return {
      disposition: ownerStatus === "alive" ? ("active" as const) : ("stale" as const),
      ledgerPath,
      ledger,
    };
  });

  const cleaned: string[] = [];
  for (const candidate of inspected) {
    if (candidate.disposition !== "stale") continue;
    const unchanged = readLinuxKvmCleanupLedger(candidate.ledgerPath);
    if (JSON.stringify(unchanged) !== JSON.stringify(candidate.ledger)) {
      throw new Error(`Linux KVM stale ledger changed during sweep: ${candidate.ledgerPath}`);
    }
    if (runtime.ownerStatus(unchanged.owner) !== "dead") {
      throw new Error(`Linux KVM stale ledger owner changed during sweep: ${candidate.ledgerPath}`);
    }
    await cleanupLibvirtLinuxKvmFromLedger(candidate.ledgerPath, {
      expectedRepositoryScope: repositoryScope,
      expectedRunScope: unchanged.runScope,
      expectedWorkRoot,
      expectedLibvirtUri: options.expectedLibvirtUri,
      runtime: options.cleanupRuntime,
    });
    cleaned.push(candidate.ledgerPath);
  }

  const pathsFor = (disposition: "current" | "fresh" | "active") =>
    inspected
      .filter((candidate) => candidate.disposition === disposition)
      .map((candidate) => candidate.ledgerPath);
  return {
    scanned: inspected.length,
    cleaned,
    preservedCurrent: pathsFor("current"),
    preservedFresh: pathsFor("fresh"),
    preservedActive: pathsFor("active"),
  };
};

interface GuestConnectionOptions {
  readonly host: string;
  readonly keyPath: string;
  readonly tools: LinuxKvmToolchain;
  readonly user: string;
}

const commandFailure = (error: unknown): LinuxKvmGuestCommandResult => {
  const failure = isUnknownRecord(error) ? error : {};
  return {
    stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    code: typeof failure.code === "number" ? failure.code : 1,
  };
};

export const connectLinuxKvmGuest = (
  options: Omit<GuestConnectionOptions, "tools"> & {
    readonly toolchain?: Partial<LinuxKvmToolchain>;
  },
): LinuxKvmGuestConnection => {
  const tools = resolveLinuxKvmToolchain(options.toolchain);
  return {
    run: async (command) => {
      try {
        const { stdout, stderr } = await execFileP(
          tools.ssh,
          ["-i", options.keyPath, ...SSH_OPTIONS, `${options.user}@${options.host}`, command],
          { maxBuffer: 64 * 1024 * 1024 },
        );
        return { stdout, stderr, code: 0 };
      } catch (error) {
        return commandFailure(error);
      }
    },
    push: async (localPath, remotePath) => {
      await execFileP(tools.scp, [
        "-i",
        options.keyPath,
        "-r",
        ...SSH_OPTIONS,
        localPath,
        `${options.user}@${options.host}:${remotePath}`,
      ]);
    },
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stopChild = async (
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs = 5_000,
) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      setTimeout(settle, 500);
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      settle();
    });
    child.kill(signal);
  });
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: node:net listen callbacks cannot return an Effect failure
        reject(new Error("temporary SSH forward did not publish a TCP address"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const waitForLocalPort = async (port: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(250, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`SSH forward on port ${port} did not start`);
};

const displayNumber = () => 200 + (Number.parseInt(randomUUID().slice(0, 6), 16) % 20_000);

const createDisplayRecording = async (options: {
  readonly activeRecordings: Set<LinuxKvmDisplayRecording>;
  readonly endpoint: string;
  readonly frameRate: number;
  readonly hostProcessMarker: (role: LinuxKvmCleanupHostProcess["role"]) => string;
  readonly outputPath: string;
  readonly size: string;
  readonly trackHostProcess: (
    role: LinuxKvmCleanupHostProcess["role"],
    child: ChildProcess,
  ) => () => void;
  readonly tools: LinuxKvmToolchain;
}) => {
  mkdirSync(dirname(options.outputPath), { recursive: true });
  const display = `:${displayNumber()}`;
  const displaySocket = `/tmp/.X11-unix/X${display.slice(1)}`;
  const processEnvironment = (role: LinuxKvmCleanupHostProcess["role"]) => ({
    ...process.env,
    DISPLAY: display,
    E2E_KVM_PROCESS_MARKER: options.hostProcessMarker(role),
  });
  let xvfb: ChildProcess | undefined;
  let openbox: ChildProcess | undefined;
  let viewer: ChildProcess | undefined;
  let ffmpeg: ChildProcess | undefined;
  let untrackXvfb: (() => void) | undefined;
  let untrackOpenbox: (() => void) | undefined;
  let untrackViewer: (() => void) | undefined;
  let untrackFfmpeg: (() => void) | undefined;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopChild(ffmpeg, "SIGINT", 15_000);
    untrackFfmpeg?.();
    await stopChild(viewer);
    untrackViewer?.();
    await stopChild(openbox);
    untrackOpenbox?.();
    await stopChild(xvfb);
    untrackXvfb?.();
    options.activeRecordings.delete(recording);
    if (!existsSync(options.outputPath) || statSync(options.outputPath).size === 0) {
      throw new Error(`SPICE recording was not written to ${options.outputPath}`);
    }
  };

  const recording: LinuxKvmDisplayRecording = {
    container: "mp4",
    outputPath: options.outputPath,
    stop,
  };

  try {
    xvfb = spawn(
      options.tools.xvfb,
      [display, "-screen", "0", `${options.size}x24`, "-nolisten", "tcp"],
      { env: processEnvironment("xvfb"), stdio: "ignore" },
    );
    untrackXvfb = options.trackHostProcess("xvfb", xvfb);
    for (let attempt = 0; attempt < 100 && !existsSync(displaySocket); attempt++) {
      if (xvfb.exitCode !== null || xvfb.signalCode !== null) {
        throw new Error("Xvfb exited before the SPICE recording display was ready");
      }
      await sleep(100);
    }
    if (!existsSync(displaySocket)) throw new Error(`Xvfb did not create ${displaySocket}`);

    openbox = spawn(options.tools.openbox, ["--sm-disable"], {
      env: processEnvironment("openbox"),
      stdio: "ignore",
    });
    untrackOpenbox = options.trackHostProcess("openbox", openbox);
    viewer = spawn(options.tools.remoteViewer, ["--kiosk", "--full-screen", options.endpoint], {
      env: processEnvironment("remote-viewer"),
      stdio: "ignore",
    });
    untrackViewer = options.trackHostProcess("remote-viewer", viewer);
    await sleep(2_000);
    if (viewer.exitCode !== null || viewer.signalCode !== null) {
      throw new Error(`remote-viewer could not open ${options.endpoint}`);
    }

    ffmpeg = spawn(
      options.tools.ffmpeg,
      [
        "-loglevel",
        "warning",
        "-f",
        "x11grab",
        "-framerate",
        String(options.frameRate),
        "-video_size",
        options.size,
        "-i",
        display,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "24",
        "-pix_fmt",
        "yuv420p",
        "-y",
        options.outputPath,
      ],
      { env: processEnvironment("ffmpeg"), stdio: "ignore" },
    );
    untrackFfmpeg = options.trackHostProcess("ffmpeg", ffmpeg);
    await sleep(1_000);
    if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
      throw new Error(`ffmpeg could not record SPICE pixels from ${display}`);
    }
    options.activeRecordings.add(recording);
    return recording;
  } catch (error) {
    await stopChild(ffmpeg, "SIGINT", 15_000);
    untrackFfmpeg?.();
    await stopChild(viewer);
    untrackViewer?.();
    await stopChild(openbox);
    untrackOpenbox?.();
    await stopChild(xvfb);
    untrackXvfb?.();
    throw error;
  }
};

const parseDomainAddress = (output: string) =>
  output.match(/\b((?:\d{1,3}\.){3}\d{1,3})\/\d+\b/)?.[1];

export const createLibvirtLinuxKvmDriver = (
  options: LibvirtLinuxKvmOptions,
): LinuxKvmDesktopDriver => ({
  provision: async () => {
    const tools = resolveLinuxKvmToolchain(options.toolchain);
    const cleanup = createLinuxKvmFinalizerStack();
    const guestUser = options.guestUser || process.env.E2E_KVM_GUEST_USER || "executor";
    const guestDisplay = options.guestDisplay || process.env.E2E_KVM_GUEST_DISPLAY || ":0";
    const libvirtUri = options.libvirtUri || process.env.E2E_LIBVIRT_URI || "qemu:///system";
    const libvirtNetwork = options.libvirtNetwork || process.env.E2E_LIBVIRT_NETWORK || "default";
    const runScope = options.runScope
      ? linuxKvmRunScope({ E2E_KVM_RUN_SCOPE: options.runScope })
      : linuxKvmRunScope();
    const repositoryScope = linuxKvmRepositoryScope(
      runScope,
      options.repositoryScope || process.env.E2E_KVM_REPOSITORY_SCOPE,
    );
    if (runScope !== repositoryScope && !runScope.startsWith(`${repositoryScope}-`)) {
      throw new Error(
        `Linux KVM run scope ${runScope} is outside repository scope ${repositoryScope}`,
      );
    }
    const resourceId = randomUUID().slice(0, 8);
    const domainName = `executor-e2e-desktop-${runScope}-${process.pid}-${resourceId}`;
    const workRoot = resolve(options.workRoot || tmpdir());
    const configuredCleanupLedgerPath =
      options.cleanupLedgerPath || process.env.E2E_KVM_CLEANUP_LEDGER;
    const cleanupLedgerPath = configuredCleanupLedgerPath
      ? resolve(configuredCleanupLedgerPath)
      : undefined;
    if (cleanupLedgerPath) {
      ensureRepositoryLedgerDirectory(dirname(cleanupLedgerPath), repositoryScope);
    }
    mkdirSync(workRoot, { recursive: true });
    const workDir = join(workRoot, `executor-kvm-${process.pid}-${resourceId}`);
    let cleanupLedger: LinuxKvmCleanupLedger | undefined;
    let cleanupLedgerActive = false;
    if (cleanupLedgerPath) {
      if (existsSync(cleanupLedgerPath)) {
        throw new Error(
          `refusing to overwrite existing Linux KVM recovery ledger: ${cleanupLedgerPath}`,
        );
      }
      cleanupLedger = {
        version: 2,
        createdAt: new Date().toISOString(),
        repositoryScope,
        runScope,
        domainName,
        libvirtUri,
        workRoot,
        workDir,
        hostProcesses: [],
        owner: linuxKvmOwnerIdentity(),
      };
      writeCleanupLedger(cleanupLedgerPath, cleanupLedger);
      cleanupLedgerActive = true;
    }
    const hostProcesses = new Map<number, LinuxKvmCleanupHostProcess>();
    const hostProcessMarker = (role: LinuxKvmCleanupHostProcess["role"]) =>
      `executor-e2e-kvm:${runScope}:${domainName}:${role}`;
    const persistHostProcesses = () => {
      if (!cleanupLedgerActive || !cleanupLedgerPath || !cleanupLedger) return;
      cleanupLedger = { ...cleanupLedger, hostProcesses: [...hostProcesses.values()] };
      writeCleanupLedger(cleanupLedgerPath, cleanupLedger);
    };
    const trackHostProcess = (role: LinuxKvmCleanupHostProcess["role"], child: ChildProcess) => {
      const pid = child.pid;
      if (!pid) throw new Error(`could not track Linux KVM ${role} process`);
      const processEntry: LinuxKvmCleanupHostProcess = {
        pid,
        role,
        marker: hostProcessMarker(role),
      };
      hostProcesses.set(pid, processEntry);
      persistHostProcesses();
      let tracked = true;
      const untrack = () => {
        if (!tracked) return;
        tracked = false;
        hostProcesses.delete(pid);
        persistHostProcesses();
      };
      child.once("exit", untrack);
      return untrack;
    };
    cleanup.add("working directory", () => rmSync(workDir, { force: true, recursive: true }));

    const virsh = (args: ReadonlyArray<string>) =>
      execFileP(tools.virsh, ["--connect", libvirtUri, ...args], {
        maxBuffer: 64 * 1024 * 1024,
      });

    cleanup.add("libvirt domain", async () => {
      const { stdout: domainNames } = await virsh(["list", "--all", "--name"]);
      const exists = domainNames.split(/\r?\n/).includes(domainName);
      if (!exists) return;
      await virsh(["destroy", domainName]).catch(() => undefined);
      await virsh(["undefine", domainName, "--nvram"]).catch(() => virsh(["undefine", domainName]));
    });

    const forwardChildren = new Set<ChildProcess>();
    cleanup.add("SSH forwards", async () => {
      await Promise.all([...forwardChildren].map((child) => stopChild(child)));
      forwardChildren.clear();
    });

    const activeRecordings = new Set<LinuxKvmDisplayRecording>();
    cleanup.add("SPICE recordings", async () => {
      const failures: unknown[] = [];
      for (const recording of [...activeRecordings]) {
        try {
          await recording.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "one or more SPICE recordings failed to finalize");
      }
    });

    let cleanupFailed = false;
    const discard = async () => {
      if (cleanupFailed) {
        throw new Error(
          `Linux KVM cleanup previously failed; recovery ledger retained at ${cleanupLedgerPath ?? "(not configured)"}`,
        );
      }
      try {
        await cleanup.run();
      } catch (error) {
        cleanupFailed = true;
        throw error;
      }
      cleanupLedgerActive = false;
      if (cleanupLedgerPath) rmSync(cleanupLedgerPath, { force: true });
    };

    try {
      mkdirSync(workDir, { mode: 0o755 });
      const keyPath = join(workDir, "id_ed25519");
      await execFileP("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
      chmodSync(keyPath, 0o600);
      const publicKey = (await execFileP("ssh-keygen", ["-y", "-f", keyPath])).stdout.trim();
      const cloudInit = linuxKvmCloudInit({ domainName, guestDisplay, guestUser, publicKey });
      const userDataPath = join(workDir, "user-data.yaml");
      const metaDataPath = join(workDir, "meta-data.yaml");
      const seedPath = join(workDir, "seed.iso");
      const overlayPath = join(workDir, "guest.qcow2");
      writeFileSync(userDataPath, cloudInit.userData);
      writeFileSync(metaDataPath, cloudInit.metaData);

      await execFileP(tools.qemuImg, [
        "create",
        "-f",
        "qcow2",
        "-F",
        options.baseImageFormat ?? "qcow2",
        "-b",
        options.baseImagePath,
        overlayPath,
      ]);
      await execFileP(tools.cloudLocalDs, [seedPath, userDataPath, metaDataPath]);
      // qemu:///system domains run as libvirt's service account, not the CI
      // runner that created these disposable files.
      chmodSync(overlayPath, 0o666);
      chmodSync(seedPath, 0o644);
      await execFileP(
        tools.virtInstall,
        libvirtDomainArgs({
          domainName,
          libvirtNetwork,
          libvirtUri,
          memoryMiB: options.memoryMiB ?? 4_096,
          osVariant: options.osVariant ?? "generic",
          overlayPath,
          seedPath,
          vcpus: options.vcpus ?? 4,
        }),
        { maxBuffer: 64 * 1024 * 1024 },
      );

      let host = "";
      for (let attempt = 0; attempt < 150 && !host; attempt++) {
        for (const source of ["agent", "lease"] as const) {
          const result = await virsh(["domifaddr", domainName, "--source", source]).catch(() => ({
            stdout: "",
          }));
          host = parseDomainAddress(result.stdout) ?? "";
          if (host) break;
        }
        if (!host) await sleep(2_000);
      }
      if (!host) throw new Error(`libvirt did not report an address for ${domainName}`);

      const guest = connectLinuxKvmGuest({ host, keyPath, user: guestUser, toolchain: tools });
      let sshReady = false;
      for (let attempt = 0; attempt < 120 && !sshReady; attempt++) {
        sshReady = (await guest.run("true")).code === 0;
        if (!sshReady) await sleep(2_000);
      }
      if (!sshReady) throw new Error(`SSH did not become ready for ${domainName}`);

      let guiReady = false;
      let guiFailure = "";
      for (let attempt = 0; attempt < 150 && !guiReady; attempt++) {
        const result = await guest.run(`DISPLAY=${guestDisplay} xdpyinfo >/dev/null 2>&1`);
        guiReady = result.code === 0;
        guiFailure = result.stderr || result.stdout;
        if (!guiReady) await sleep(2_000);
      }
      if (!guiReady) {
        const service = await guest.run(
          "sudo systemctl status executor-e2e-gui.service --no-pager || true",
        );
        throw new Error(
          `guest Xorg session ${guestDisplay} did not become ready\n${guiFailure}\n${service.stdout}\n${service.stderr}`,
        );
      }

      const endpoint = (await virsh(["domdisplay", domainName, "--type", "spice"])).stdout.trim();
      if (!endpoint.startsWith("spice://")) {
        throw new Error(`libvirt returned an invalid SPICE endpoint: ${endpoint}`);
      }

      const handle: LinuxKvmDesktopHandle = {
        kind: "desktop-gui",
        os: "linux",
        arch: "x64",
        host,
        sshKeyPath: keyPath,
        sshUser: guestUser,
        display: {
          protocol: "spice",
          endpoint,
          startRecording: (outputPath) =>
            createDisplayRecording({
              activeRecordings,
              endpoint,
              frameRate: options.recordingFrameRate ?? 24,
              hostProcessMarker,
              outputPath,
              size: options.recordingSize ?? "1440x900",
              trackHostProcess,
              tools,
            }),
        },
        run: guest.run,
        push: guest.push,
        forward: async (guestPort) => {
          const localPort = await freePort();
          const child = spawn(
            tools.ssh,
            [
              "-i",
              keyPath,
              ...SSH_OPTIONS,
              "-N",
              "-L",
              `${localPort}:127.0.0.1:${guestPort}`,
              `${guestUser}@${host}`,
            ],
            {
              env: {
                ...process.env,
                E2E_KVM_PROCESS_MARKER: hostProcessMarker("ssh-forward"),
              },
              stdio: "ignore",
            },
          );
          const untrack = trackHostProcess("ssh-forward", child);
          forwardChildren.add(child);
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            child.kill();
          };
          child.once("error", close);
          child.once("exit", () => {
            forwardChildren.delete(child);
            untrack();
          });
          try {
            await waitForLocalPort(localPort);
          } catch (error) {
            await stopChild(child);
            forwardChildren.delete(child);
            untrack();
            throw error;
          }
          return { localPort, close };
        },
        discard,
      };
      return handle;
    } catch (error) {
      try {
        await discard();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Linux KVM provisioning failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  },
});

export const libvirtLinuxKvmDesktop = (options: LibvirtLinuxKvmOptions) =>
  createLinuxKvmDesktopProvider(createLibvirtLinuxKvmDriver(options), {
    baseImagePath: options.baseImagePath,
    libvirtNetwork: options.libvirtNetwork,
    libvirtUri: options.libvirtUri,
    runtime: options.preflightRuntime,
    toolchain: options.toolchain,
  });
