// desktop-windows: drive the PACKAGED app running in a Windows guest over CDP.
// Windows-in-a-VM works best with dockur (QEMU on a Linux/KVM host): autologin
// gives a real interactive session the app renders into, and QEMU `screendump`
// films the framebuffer directly — sidestepping the session-0 problem that
// defeats SSH-driven screenshots (the prior proof of this path).
//
// Unlike the tart targets this ATTACHES to a long-lived Windows host (the dockur
// guest stays up between runs, like a shared selfhost): it forwards the guest's
// --remote-debugging-port to the host over an SSH jump and publishes it. The
// shared scenario drives; the windows recorder (src/vm/desktop.ts) films via
// screendump. Without a reachable app it skips honestly. All connection details
// come from env (no baked-in host):
//   E2E_DESKTOP_WIN_HOST (ssh alias of the docker/KVM host to jump through),
//   _SSH_PORT (the guest's mapped OpenSSH port), _KEY, _USER; the recorder also
//   reads _CONTAINER and _STORAGE.
import { spawn } from "node:child_process";
import net from "node:net";

const SSH_PORT = process.env.E2E_DESKTOP_WIN_SSH_PORT ?? "2222";
const KEY = process.env.E2E_DESKTOP_WIN_KEY ?? "/tmp/winkey";
const USER = process.env.E2E_DESKTOP_WIN_USER ?? "Administrator";
const CDP_GUEST_PORT = 9222;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

interface CdpTarget {
  readonly type: string;
  readonly webSocketDebuggerUrl?: string;
}

/** Poll the forwarded port until the app advertises a CDP page target. */
const pageReady = async (port: number, attempts = 30): Promise<boolean> => {
  for (let i = 0; i < attempts; i++) {
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])) as ReadonlyArray<CdpTarget>;
    if (targets.some((t) => t.type === "page" && t.webSocketDebuggerUrl)) return true;
    await sleep(2000);
  }
  return false;
};

export default async function setup(): Promise<(() => Promise<void>) | void> {
  const host = process.env.E2E_DESKTOP_WIN_HOST;
  if (!host) {
    console.warn(
      "[desktop-windows] E2E_DESKTOP_WIN_HOST not set; scenario will skip. Point it at the ssh " +
        "alias of a dockur/KVM Windows host running the packaged app with --remote-debugging-port.",
    );
    return;
  }
  const localPort = await freePort();
  // mac:localPort → (jump host) → guest:9222. -p is the guest's mapped OpenSSH
  // port on the host; the final hop into Windows carries the -L forward.
  const tunnel = spawn(
    "ssh",
    [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=12",
      "-o",
      "ServerAliveInterval=15",
      "-J",
      host,
      "-p",
      SSH_PORT,
      "-i",
      KEY,
      "-L",
      `${localPort}:127.0.0.1:${CDP_GUEST_PORT}`,
      "-N",
      `${USER}@127.0.0.1`,
    ],
    { stdio: "ignore" },
  );

  if (!(await pageReady(localPort))) {
    tunnel.kill();
    console.warn(
      `[desktop-windows] no app/CDP reachable on the Windows host (${host}); scenario will skip. ` +
        `Bring up the packaged app with --remote-debugging-port=${CDP_GUEST_PORT} in the dockur guest.`,
    );
    return;
  }

  process.env.E2E_DESKTOP_CDP_PORT = String(localPort);
  // Non-empty so the scenario runs; the windows recorder uses E2E_DESKTOP_WIN_*.
  process.env.E2E_DESKTOP_VM_IP = host;

  return async () => {
    tunnel.kill();
  };
}
