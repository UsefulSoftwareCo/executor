// tart provider: macOS + Linux guests on an Apple-Silicon host (the Mini).
// Mirrors the by-hand reboot harness — clone a base image, boot headless, drive
// over sshpass, reboot the guest OS for real, tear down the clone.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import {
  type SshResult,
  sleep,
  type Tunnel,
  type VmArch,
  type VmHandle,
  type VmProvider,
} from "./types";

const execFileP = promisify(execFile);

const TART = process.env.E2E_TART_BIN ?? "/opt/homebrew/bin/tart";
const SSHPASS = process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass";
const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "LogLevel=ERROR",
  // We authenticate with sshpass (password). A loaded SSH agent would otherwise
  // offer its keys first and exhaust the guest's MaxAuthTries ("Too many
  // authentication failures") before the password is tried — intermittently,
  // depending on how many keys the agent holds. Force password-only.
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "IdentitiesOnly=yes",
];
const GUEST_USER = "admin";
const GUEST_PASS = "admin";

/**
 * Reboot a tart guest by address, with no live handle. `restart()` runs in a
 * vitest worker (separate process from the globalsetup that owns the VM), so it
 * re-derives the guest address from env and triggers the reboot statelessly —
 * the reconnecting tunnel and a health poll confirm recovery.
 */
export const sshRebootGuest = async (ip: string): Promise<void> => {
  await execFileP(SSHPASS, [
    "-p",
    GUEST_PASS,
    "ssh",
    ...SSH_OPTS,
    `${GUEST_USER}@${ip}`,
    "sudo reboot",
  ]).catch(() => undefined); // the connection drops mid-call
};

const baseImage = (os: "macos" | "linux"): string =>
  os === "macos"
    ? (process.env.E2E_TART_MACOS_BASE ?? "executor-macos-base")
    : (process.env.E2E_TART_LINUX_BASE ?? "executor-linux-base");

/** Ask the OS for a free localhost port (for SSH tunnels). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

/** Resolve once a TCP connect to localhost:port succeeds (SSH bound the forward). */
const waitLocalPort = async (port: number, attempts = 40): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`tunnel local port ${port} never came up`);
};

export const tartVm = (os: "macos" | "linux", arch: VmArch = "arm64"): VmProvider => ({
  os,
  provision: async () => {
    const name = `executor-e2e-${os}-${process.pid}-${Math.floor(performance.now())}`;
    await execFileP(TART, ["clone", baseImage(os), name]);
    // `--no-graphics` opens NO host window (never steals focus) yet the guest
    // still has a virtual display: with the base image's autologin it reaches a
    // real Aqua session (WindowServer/Dock/Finder), so even the packaged GUI app
    // renders and `screencapture` records it. No windowed/VNC mode is needed.
    const runProc = spawn(TART, ["run", name, "--no-graphics"], {
      stdio: "ignore",
      detached: true,
    });
    runProc.unref();

    const tunnelClosers: Array<() => void> = [];
    let ip = "";

    const fetchIp = async (): Promise<boolean> => {
      for (let i = 0; i < 90; i++) {
        try {
          const { stdout } = await execFileP(TART, ["ip", name]);
          if (stdout.trim()) {
            ip = stdout.trim();
            return true;
          }
        } catch {
          /* not booted yet */
        }
        await sleep(2000);
      }
      return false;
    };

    // Linux systemctl --user calls need XDG_RUNTIME_DIR; harmless elsewhere.
    const wrap = (command: string): string =>
      os === "linux" ? `export XDG_RUNTIME_DIR=/run/user/$(id -u); ${command}` : command;

    const ssh = async (command: string): Promise<SshResult> => {
      try {
        const { stdout, stderr } = await execFileP(
          SSHPASS,
          ["-p", GUEST_PASS, "ssh", ...SSH_OPTS, `${GUEST_USER}@${ip}`, wrap(command)],
          { maxBuffer: 32 * 1024 * 1024 },
        );
        return { stdout, stderr, code: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          code: typeof e.code === "number" ? e.code : 1,
        };
      }
    };

    const waitSsh = async (attempts: number): Promise<boolean> => {
      for (let i = 0; i < attempts; i++) {
        if ((await ssh("true")).code === 0) return true;
        await sleep(2000);
      }
      return false;
    };

    const handle: VmHandle = {
      os,
      arch,
      get host() {
        return ip;
      },
      ssh,
      push: async (localPath, remotePath) => {
        await execFileP(SSHPASS, [
          "-p",
          GUEST_PASS,
          "scp",
          "-r",
          ...SSH_OPTS,
          localPath,
          `${GUEST_USER}@${ip}:${remotePath}`,
        ]);
      },
      reboot: async () => {
        await ssh("sudo reboot").catch(() => undefined); // connection drops mid-call
        await sleep(5000);
        if (!(await fetchIp())) throw new Error(`tart ${os}: no IP after reboot`);
        if (!(await waitSsh(120))) throw new Error(`tart ${os}: SSH did not return after reboot`);
      },
      tunnel: async (guestPort) => {
        const localPort = await freePort();
        // Reconnecting forward: when the guest reboots the ssh exits, so respawn
        // it until closed. `restart()` health-polls through this local port, so
        // it only goes green once the daemon AND the forward are back.
        let closed = false;
        let child: ChildProcess | undefined;
        const spawnOnce = (): void => {
          child = spawn(
            SSHPASS,
            [
              "-p",
              GUEST_PASS,
              "ssh",
              ...SSH_OPTS,
              "-N",
              "-L",
              `${localPort}:127.0.0.1:${guestPort}`,
              `${GUEST_USER}@${ip}`,
            ],
            { stdio: "ignore" },
          );
          child.on("exit", () => {
            if (!closed) setTimeout(spawnOnce, 2000);
          });
        };
        spawnOnce();
        const close = (): void => {
          closed = true;
          child?.kill();
        };
        tunnelClosers.push(close);
        await waitLocalPort(localPort);
        const tunnel: Tunnel = { localPort, close };
        return tunnel;
      },
      discard: async () => {
        for (const close of tunnelClosers) close();
        runProc.kill();
        await sleep(1500);
        await execFileP(TART, ["delete", name]).catch(() => undefined);
      },
    };

    if (!(await fetchIp())) {
      await handle.discard();
      throw new Error(`tart ${os}: no IP within 180s`);
    }
    if (!(await waitSsh(90))) {
      await handle.discard();
      throw new Error(`tart ${os}: SSH never came up`);
    }
    return handle;
  },
});
