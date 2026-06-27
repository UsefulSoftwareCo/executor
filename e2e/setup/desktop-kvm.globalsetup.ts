// Required, opt-in Linux desktop lane. The host builds the real packaged app,
// then a disposable libvirt/QEMU guest runs it on a QXL-backed Xorg display.
// remote-viewer projects the guest's SPICE framebuffer onto a dedicated host X
// display and ffmpeg records those pixels for the entire acceptance journey.

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requirePackagedDesktopBundle } from "../src/desktop/packaged";
import { libvirtLinuxKvmDesktop } from "../src/vm/linux-kvm-libvirt";
import type { LinuxKvmDesktopHandle } from "../src/vm/linux-kvm";
import setupPackagedDesktop from "./desktop-packaged.globalsetup";

const e2eRoot = fileURLToPath(new URL("../", import.meta.url));
const optionalEnv = (name: string) => process.env[name] || undefined;
const expectedBunVersion = () => optionalEnv("E2E_BUN_VERSION") ?? "1.3.11";
const expectedClaudeVersion = () => optionalEnv("E2E_CLAUDE_CODE_VERSION") ?? "2.1.195";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const executablePath = (environmentName: string, command: string) => {
  const configured = optionalEnv(environmentName);
  const path = configured ?? execFileSync("which", [command], { encoding: "utf8" }).trim();
  if (!path) throw new Error(`${command} is required for the desktop KVM guest payload`);
  return realpathSync(path);
};

const firstVersionToken = (binary: string, args: ReadonlyArray<string>) =>
  /^(\S+)/.exec(execFileSync(binary, [...args], { encoding: "utf8" }).trim())?.[1];

export default async function setup() {
  const baseImagePath = process.env.E2E_KVM_BASE_IMAGE ?? "";
  const guestDisplay = optionalEnv("E2E_KVM_GUEST_DISPLAY") ?? ":0";
  const provider = libvirtLinuxKvmDesktop({
    baseImagePath,
    baseImageFormat: optionalEnv("E2E_KVM_BASE_FORMAT"),
    cleanupLedgerPath: optionalEnv("E2E_KVM_CLEANUP_LEDGER"),
    guestDisplay,
    guestUser: optionalEnv("E2E_KVM_GUEST_USER"),
    libvirtNetwork: optionalEnv("E2E_LIBVIRT_NETWORK"),
    libvirtUri: optionalEnv("E2E_LIBVIRT_URI"),
    osVariant: optionalEnv("E2E_KVM_OS_VARIANT"),
    repositoryScope: optionalEnv("E2E_KVM_REPOSITORY_SCOPE"),
    runScope: optionalEnv("E2E_KVM_RUN_SCOPE"),
    workRoot: optionalEnv("E2E_KVM_WORK_ROOT"),
  });

  await provider.preflight("required");
  const bunPath = executablePath("E2E_BUN_BIN", "bun");
  const claudePath = executablePath("E2E_CLAUDE_CODE_BIN", "claude");
  const bunVersion = firstVersionToken(bunPath, ["--version"]);
  const claudeVersion = firstVersionToken(claudePath, ["--version"]);
  if (bunVersion !== expectedBunVersion()) {
    throw new Error(`Bun ${expectedBunVersion()} is required, found ${bunVersion ?? "unknown"}`);
  }
  if (claudeVersion !== expectedClaudeVersion()) {
    throw new Error(
      `Claude Code ${expectedClaudeVersion()} is required, found ${claudeVersion ?? "unknown"}`,
    );
  }
  setupPackagedDesktop();
  const bundle = requirePackagedDesktopBundle();
  const artifactDir = join(
    e2eRoot,
    "runs",
    "desktop-kvm",
    `${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}-${process.pid}`,
  );
  mkdirSync(artifactDir, { recursive: true });

  let vm: LinuxKvmDesktopHandle | undefined;
  try {
    vm = await provider.provision();
    const remoteRoot = `/home/${vm.sshUser}/executor-desktop-e2e`;
    const remoteHome = `/home/${vm.sshUser}/executor-desktop-home`;
    const remoteTools = `/home/${vm.sshUser}/executor-kvm-tools`;
    const remoteApp = `${remoteRoot}/${basename(bundle.app)}`;
    const remoteBun = `${remoteTools}/bun`;
    const remoteClaude = `${remoteTools}/claude`;
    const remoteGuestRuntime = `${remoteTools}/guest-runtime.ts`;
    const guestRuntimeSource = fileURLToPath(
      new URL("../desktop-kvm/guest-runtime.ts", import.meta.url),
    );
    await vm.run(
      `rm -rf '${remoteRoot}' '${remoteHome}' '${remoteTools}' && mkdir -p '${remoteHome}' '${remoteTools}'`,
    );
    await vm.push(dirname(bundle.app), remoteRoot);
    await vm.push(bunPath, remoteBun);
    await vm.push(claudePath, remoteClaude);
    await vm.push(guestRuntimeSource, remoteGuestRuntime);
    const prepared = await vm.run(
      `find '${remoteRoot}' -type f \\( -name executor -o -name executor-sidecar -o -name executor-desktop \\) -exec chmod +x {} + && chmod 755 '${remoteBun}' '${remoteClaude}' && chmod 600 '${remoteGuestRuntime}' && test -x '${remoteApp}' && test -x '${remoteBun}' && test -x '${remoteClaude}'`,
    );
    if (prepared.code !== 0) {
      throw new Error(`packaged desktop upload failed: ${prepared.stderr || prepared.stdout}`);
    }
    const guestVersionProbe = await vm.run(
      `${shellQuote(remoteBun)} --version && ${shellQuote(remoteClaude)} --version`,
    );
    const [guestBunVersion, guestClaudeVersionLine] = guestVersionProbe.stdout
      .trim()
      .split(/\r?\n/);
    const guestClaudeVersion = /^(\S+)/.exec(guestClaudeVersionLine ?? "")?.[1];
    if (
      guestVersionProbe.code !== 0 ||
      guestBunVersion !== expectedBunVersion() ||
      guestClaudeVersion !== expectedClaudeVersion()
    ) {
      throw new Error(
        `guest client probe failed: expected Bun ${expectedBunVersion()} and Claude Code ${expectedClaudeVersion()}, got ${guestBunVersion ?? "unknown"} and ${guestClaudeVersion ?? "unknown"}\n${guestVersionProbe.stderr}`,
      );
    }

    const recordingPath = join(artifactDir, "session.mp4");
    await vm.display.startRecording(recordingPath);
    const cdpForward = await vm.forward(9_222);

    process.env.E2E_KVM_ARTIFACT_DIR = artifactDir;
    process.env.E2E_KVM_CDP_PORT = String(cdpForward.localPort);
    process.env.E2E_KVM_GUEST_DISPLAY = guestDisplay;
    process.env.E2E_KVM_GUEST_HOST = vm.host;
    process.env.E2E_KVM_GUEST_USER = vm.sshUser;
    process.env.E2E_KVM_RECORDING_PATH = recordingPath;
    process.env.E2E_KVM_REMOTE_APP = remoteApp;
    process.env.E2E_KVM_REMOTE_BUN = remoteBun;
    process.env.E2E_KVM_REMOTE_CLAUDE = remoteClaude;
    process.env.E2E_KVM_REMOTE_GUEST_RUNTIME = remoteGuestRuntime;
    process.env.E2E_KVM_REMOTE_HOME = remoteHome;
    process.env.E2E_KVM_SSH_KEY = vm.sshKeyPath;
    process.env.E2E_KVM_CLAUDE_CODE_VERSION = expectedClaudeVersion();
  } catch (error) {
    if (vm) {
      try {
        await vm.discard();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "desktop KVM setup failed and guest cleanup was incomplete",
        );
      }
    }
    throw error;
  }

  return async () => {
    await vm?.discard();
  };
}
