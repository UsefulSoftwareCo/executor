// VM substrate for the cross-OS supervised-daemon e2e targets.
//
// A VmHandle is a booted guest we can drive over SSH, REBOOT for real, and tear
// down. Providers: tart (macOS + Linux, local on an Apple-Silicon host) and ec2
// (Windows, ephemeral). This is the codified form of the by-hand reboot harness.

export type VmOs = "macos" | "linux" | "windows";
export type VmArch = "arm64" | "x64";

export interface SshResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** An open SSH local-forward (`localhost:localPort` → guest:guestPort). */
export interface Tunnel {
  readonly localPort: number;
  close(): void;
}

export interface VmHandle {
  readonly os: VmOs;
  readonly arch: VmArch;
  /** Current reachable address of the guest (re-resolved across reboots). */
  readonly host: string;
  /**
   * Path to the SSH private key for key-based providers (EC2). Undefined for
   * password-based providers (tart/sshpass). Published by globalsetup so the
   * stateless worker-side `restart()` can reboot the guest.
   */
  readonly sshKeyPath?: string;
  /** Run a command in the guest over SSH (shell on Unix, PowerShell on Windows). */
  ssh(command: string): Promise<SshResult>;
  /** Copy a local file or directory into the guest (recursive for directories). */
  push(localPath: string, remotePath: string): Promise<void>;
  /** Reboot the guest OS; resolves only once SSH is reachable again. */
  reboot(): Promise<void>;
  /** Forward `localhost:<localPort>` → `guest:<guestPort>` over SSH. */
  tunnel(guestPort: number): Promise<Tunnel>;
  /** Discard the VM (delete the tart clone / terminate the EC2 instance). */
  discard(): Promise<void>;
}

export interface VmProvider {
  readonly os: VmOs;
  /** Boot a fresh guest and wait until SSH answers. */
  provision(): Promise<VmHandle>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
