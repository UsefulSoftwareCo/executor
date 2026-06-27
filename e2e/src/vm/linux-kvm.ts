// Linux KVM substrate for headed desktop scenarios. This contract is separate
// from VmProvider, which models supervised CLI daemons reached through SSH.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const LINUX_KVM_DESKTOP_CAPABILITIES = {
  guest: { arch: "x64", os: "linux" },
  workload: "desktop-gui",
  display: { interactive: true, protocol: "spice" },
  recording: { container: "mp4", required: true, source: "guest-display" },
} as const;

export type LinuxKvmRequirement = "optional" | "required";
export type LinuxKvmCheckName =
  | "kvm-device"
  | "base-image"
  | "qemu"
  | "libvirt"
  | "cloud-init"
  | "guest-transport"
  | "display-recorder";

export interface LinuxKvmToolchain {
  readonly cloudLocalDs: string;
  readonly ffmpeg: string;
  readonly openbox: string;
  readonly qemu: string;
  readonly qemuImg: string;
  readonly remoteViewer: string;
  readonly scp: string;
  readonly ssh: string;
  readonly virsh: string;
  readonly virtInstall: string;
  readonly xvfb: string;
}

export const resolveLinuxKvmToolchain = (
  overrides: Partial<LinuxKvmToolchain> = {},
): LinuxKvmToolchain => ({
  cloudLocalDs: process.env.E2E_CLOUD_LOCALDS_BIN ?? "cloud-localds",
  ffmpeg: process.env.E2E_FFMPEG_BIN ?? "ffmpeg",
  openbox: process.env.E2E_OPENBOX_BIN ?? "openbox",
  qemu: process.env.E2E_QEMU_BIN ?? "qemu-system-x86_64",
  qemuImg: process.env.E2E_QEMU_IMG_BIN ?? "qemu-img",
  remoteViewer: process.env.E2E_REMOTE_VIEWER_BIN ?? "remote-viewer",
  scp: process.env.E2E_SCP_BIN ?? "scp",
  ssh: process.env.E2E_SSH_BIN ?? "ssh",
  virsh: process.env.E2E_VIRSH_BIN ?? "virsh",
  virtInstall: process.env.E2E_VIRT_INSTALL_BIN ?? "virt-install",
  xvfb: process.env.E2E_XVFB_BIN ?? "Xvfb",
  ...overrides,
});

export interface LinuxKvmCheck {
  readonly name: LinuxKvmCheckName;
  readonly available: boolean;
  readonly detail: string;
}

export interface LinuxKvmAvailability {
  readonly status: "available" | "unavailable";
  readonly checks: ReadonlyArray<LinuxKvmCheck>;
  readonly capabilities: typeof LINUX_KVM_DESKTOP_CAPABILITIES;
  readonly summary: string;
}

export interface LinuxKvmPreflightRuntime {
  access(path: string, mode: number): Promise<void>;
  exec(command: string, args: ReadonlyArray<string>): Promise<{ stdout: string; stderr: string }>;
  report(message: string): void;
}

export interface LinuxKvmPreflightOptions {
  readonly requirement?: LinuxKvmRequirement;
  readonly baseImagePath?: string;
  readonly libvirtUri?: string;
  readonly libvirtNetwork?: string;
  readonly toolchain?: Partial<LinuxKvmToolchain>;
  readonly runtime?: LinuxKvmPreflightRuntime;
}

const defaultRuntime: LinuxKvmPreflightRuntime = {
  access,
  exec: async (command, args) => {
    const { stdout, stderr } = await execFileP(command, [...args]);
    return { stdout, stderr };
  },
  report: (message) => console.warn(message),
};

const firstLine = (value: string) => value.trim().split(/\r?\n/, 1)[0] ?? "";

const probe = async (
  name: LinuxKvmCheckName,
  availableDetail: string,
  check: () => Promise<string | void>,
) => {
  try {
    const detail = await check();
    return { name, available: true, detail: detail || availableDetail } satisfies LinuxKvmCheck;
  } catch (error) {
    return { name, available: false, detail: String(error) } satisfies LinuxKvmCheck;
  }
};

export class LinuxKvmUnavailableError extends Error {
  readonly availability: LinuxKvmAvailability;

  constructor(availability: LinuxKvmAvailability) {
    super(availability.summary);
    this.name = "LinuxKvmUnavailableError";
    this.availability = availability;
  }
}

export const preflightLinuxKvm = async (options: LinuxKvmPreflightOptions = {}) => {
  const requirement = options.requirement ?? "optional";
  const runtime = options.runtime ?? defaultRuntime;
  const baseImagePath = options.baseImagePath || process.env.E2E_KVM_BASE_IMAGE;
  const tools = resolveLinuxKvmToolchain(options.toolchain);
  const libvirtUri = options.libvirtUri || process.env.E2E_LIBVIRT_URI || "qemu:///system";
  const libvirtNetwork = options.libvirtNetwork || process.env.E2E_LIBVIRT_NETWORK || "default";

  const checks = await Promise.all([
    probe("kvm-device", "/dev/kvm is readable and writable", async () => {
      await runtime.access("/dev/kvm", constants.R_OK | constants.W_OK);
    }),
    probe("base-image", "the prepared desktop base image is readable", async () => {
      if (!baseImagePath) throw new Error("E2E_KVM_BASE_IMAGE is not set");
      await runtime.access(baseImagePath, constants.R_OK);
      return baseImagePath;
    }),
    probe("qemu", `${tools.qemu} and ${tools.qemuImg} are executable`, async () => {
      const result = await runtime.exec(tools.qemu, ["--version"]);
      await runtime.exec(tools.qemuImg, ["--version"]);
      return firstLine(result.stdout || result.stderr);
    }),
    probe("libvirt", `${libvirtUri} is reachable`, async () => {
      await runtime.exec(tools.virtInstall, ["--version"]);
      await runtime.exec(tools.virsh, ["--version"]);
      const result = await runtime.exec(tools.virsh, ["--connect", libvirtUri, "uri"]);
      await runtime.exec(tools.virsh, ["--connect", libvirtUri, "net-info", libvirtNetwork]);
      return firstLine(result.stdout || result.stderr);
    }),
    probe("cloud-init", `${tools.cloudLocalDs} is executable`, async () => {
      const result = await runtime.exec(tools.cloudLocalDs, ["--help"]);
      return firstLine(result.stdout || result.stderr);
    }),
    probe("guest-transport", `${tools.ssh} is executable`, async () => {
      const result = await runtime.exec(tools.ssh, ["-V"]);
      return firstLine(result.stdout || result.stderr);
    }),
    probe("display-recorder", "SPICE display capture tools are executable", async () => {
      const result = await runtime.exec(tools.ffmpeg, ["-version"]);
      await runtime.exec(tools.xvfb, ["-help"]);
      await runtime.exec(tools.openbox, ["--version"]);
      await runtime.exec(tools.remoteViewer, ["--version"]);
      return firstLine(result.stdout || result.stderr);
    }),
  ]);

  const missing = checks.filter((check) => !check.available);
  const status = missing.length === 0 ? "available" : "unavailable";
  const summary =
    status === "available"
      ? "Linux KVM desktop provider is available"
      : `Linux KVM desktop provider is unavailable: ${missing
          .map((check) => `${check.name} (${check.detail})`)
          .join(", ")}`;
  const availability: LinuxKvmAvailability = {
    status,
    checks,
    capabilities: LINUX_KVM_DESKTOP_CAPABILITIES,
    summary,
  };

  if (status === "unavailable" && requirement === "required") {
    throw new LinuxKvmUnavailableError(availability);
  }
  if (status === "unavailable") runtime.report(`${summary} [optional]`);
  return availability;
};

export interface LinuxKvmDisplayRecording {
  readonly container: "mp4";
  readonly outputPath: string;
  stop(): Promise<void>;
}

export interface LinuxKvmDisplaySession {
  readonly protocol: "spice";
  readonly endpoint: string;
  startRecording(outputPath: string): Promise<LinuxKvmDisplayRecording>;
}

export interface LinuxKvmGuestCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface LinuxKvmPortForward {
  readonly localPort: number;
  close(): void;
}

export interface LinuxKvmGuestConnection {
  run(command: string): Promise<LinuxKvmGuestCommandResult>;
  push(localPath: string, remotePath: string): Promise<void>;
}

export interface LinuxKvmDesktopHandle extends LinuxKvmGuestConnection {
  readonly kind: "desktop-gui";
  readonly os: "linux";
  readonly arch: "x64";
  readonly host: string;
  readonly sshKeyPath: string;
  readonly sshUser: string;
  readonly display: LinuxKvmDisplaySession;
  forward(guestPort: number): Promise<LinuxKvmPortForward>;
  discard(): Promise<void>;
}

export interface LinuxKvmDesktopDriver {
  provision(): Promise<LinuxKvmDesktopHandle>;
}

export interface LinuxKvmDesktopProvider {
  readonly kind: "desktop-gui";
  readonly capabilities: typeof LINUX_KVM_DESKTOP_CAPABILITIES;
  preflight(requirement?: LinuxKvmRequirement): Promise<LinuxKvmAvailability>;
  provision(): Promise<LinuxKvmDesktopHandle>;
}

export const createLinuxKvmDesktopProvider = (
  driver: LinuxKvmDesktopDriver,
  preflightOptions: Omit<LinuxKvmPreflightOptions, "requirement"> = {},
): LinuxKvmDesktopProvider => ({
  kind: "desktop-gui",
  capabilities: LINUX_KVM_DESKTOP_CAPABILITIES,
  preflight: (requirement = "optional") => preflightLinuxKvm({ ...preflightOptions, requirement }),
  provision: async () => {
    await preflightLinuxKvm({ ...preflightOptions, requirement: "required" });
    return driver.provision();
  },
});
