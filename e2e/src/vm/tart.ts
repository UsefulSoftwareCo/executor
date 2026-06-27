// tart provider: macOS + Linux guests on an Apple-Silicon host (the Mini).
// Mirrors the by-hand reboot harness: clone a base image, boot headless, drive
// over sshpass, reboot the guest OS for real, tear down the clone.

import { execFile, spawn } from "node:child_process";
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
import { resolveVmRunMetadata } from "./run-scope";
import { deleteTartVmAndVerify, tartResourceName, terminateTartRunProcess } from "./tart-lifecycle";
import { createTartOwnership, removeTartOwnership, writeTartOwnership } from "./tart-ownership";

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
];
const GUEST_USER = "admin";
const GUEST_PASS = "admin";

export interface ReconnectingChild {
  on(event: "error" | "exit", listener: () => void): unknown;
  kill(): unknown;
}

/**
 * Owns one reconnecting child process. Pausing or closing invalidates an
 * in-flight async spawn, kills the active child, and clears its retry timer.
 */
export const createReconnectingProcess = (
  spawnChild: () => Promise<ReconnectingChild> | ReconnectingChild,
  reconnectDelayMs = 2_000,
) => {
  let child: ReconnectingChild | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let starting = false;
  let paused = true;
  let closed = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (closed || paused || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void spawnOnce();
    }, reconnectDelayMs);
  };

  const spawnOnce = async () => {
    if (closed || paused || starting || child) return;
    const attempt = ++generation;
    starting = true;
    try {
      const spawned = await spawnChild();
      if (closed || paused || attempt !== generation) {
        spawned.kill();
        return;
      }

      child = spawned;
      let settled = false;
      const onStopped = () => {
        if (settled) return;
        settled = true;
        if (child === spawned) child = undefined;
        scheduleReconnect();
      };
      spawned.on("error", onStopped);
      spawned.on("exit", onStopped);
    } catch {
      scheduleReconnect();
    } finally {
      if (attempt === generation) starting = false;
    }
  };

  const pause = () => {
    if (closed) return;
    paused = true;
    generation += 1;
    starting = false;
    clearReconnectTimer();
    const active = child;
    child = undefined;
    active?.kill();
  };

  const resume = () => {
    if (closed || !paused) return;
    paused = false;
    void spawnOnce();
  };

  const close = () => {
    if (closed) return;
    pause();
    closed = true;
  };

  return { close, pause, resume };
};

/**
 * Reboot a tart guest by address, with no live handle. `restart()` runs in a
 * vitest worker (separate process from the globalsetup that owns the VM), so it
 * re-derives the guest address from env and triggers the reboot statelessly,
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
    const metadata = resolveVmRunMetadata();
    const name = tartResourceName(
      metadata.scope,
      os,
      `${process.pid}-${Math.floor(performance.now())}`,
    );
    const ownership = writeTartOwnership(createTartOwnership(metadata, os, name));
    await execFileP(TART, ["clone", baseImage(os), name]);
    const runProc = spawn(TART, ["run", name, "--no-graphics"], { stdio: "ignore" });
    const tartRunner = async (args: readonly string[]) => {
      const { stdout } = await execFileP(TART, [...args]);
      return stdout;
    };

    const tunnels = new Set<ReturnType<typeof createReconnectingProcess>>();
    let ip = "";

    const discoverIp = async () => {
      const { stdout } = await execFileP(TART, ["ip", name]);
      const discovered = stdout.trim();
      if (!discovered) throw new Error(`tart ${os}: IP is not available`);
      ip = discovered;
      return discovered;
    };

    const fetchIp = async (): Promise<boolean> => {
      for (let i = 0; i < 90; i++) {
        try {
          await discoverIp();
          return true;
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

    let discardPromise: Promise<void> | undefined;
    const discard = () => {
      discardPromise ??= (async () => {
        for (const tunnel of tunnels) tunnel.close();
        tunnels.clear();
        const failures: unknown[] = [];
        try {
          await terminateTartRunProcess(runProc);
        } catch (error) {
          failures.push(new AggregateError([error], `failed to stop tart run process: ${name}`));
        }
        try {
          await deleteTartVmAndVerify(name, tartRunner);
          removeTartOwnership(ownership);
        } catch (error) {
          failures.push(
            new AggregateError([error], `failed to delete tart VM or ownership: ${name}`),
          );
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `tart ${os}: discard was incomplete`);
        }
      })();
      return discardPromise;
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
        for (const tunnel of tunnels) tunnel.pause();
        await ssh("sudo reboot").catch(() => undefined); // connection drops mid-call
        ip = "";
        await sleep(5000);
        if (!(await fetchIp())) throw new Error(`tart ${os}: no IP after reboot`);
        if (!(await waitSsh(120))) throw new Error(`tart ${os}: SSH did not return after reboot`);
        for (const tunnel of tunnels) tunnel.resume();
      },
      tunnel: async (guestPort) => {
        const localPort = await freePort();
        // Resolve the address before every spawn. A DHCP address can change
        // while restart() runs in a worker that has no live VM handle.
        const controller = createReconnectingProcess(async () => {
          const currentIp = await discoverIp();
          return spawn(
            SSHPASS,
            [
              "-p",
              GUEST_PASS,
              "ssh",
              ...SSH_OPTS,
              "-N",
              "-L",
              `${localPort}:127.0.0.1:${guestPort}`,
              `${GUEST_USER}@${currentIp}`,
            ],
            { stdio: "ignore" },
          );
        });
        tunnels.add(controller);
        controller.resume();
        try {
          await waitLocalPort(localPort);
        } catch (error) {
          controller.close();
          tunnels.delete(controller);
          throw error;
        }
        const close = () => {
          controller.close();
          tunnels.delete(controller);
        };
        const tunnel: Tunnel = { localPort, close };
        return tunnel;
      },
      discard,
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
