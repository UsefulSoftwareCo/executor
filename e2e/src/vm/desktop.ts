// Driving the PACKAGED desktop app inside a GUI guest, from the host. This is
// the shared substrate for the cross-OS desktop targets (Gap A): SSH plumbing,
// an SSH local-forward, a minimal CDP page client, and screen recording — the
// pieces proven against a tart macOS guest. The desktop-<os> globalsetup boots
// the guest and launches the app; a scenario connects over CDP and records.
//
// Why these mechanics (macOS): a tart `--no-graphics` guest opens no host window
// (no focus stealing) yet, with the base image's autologin, still reaches a real
// Aqua session (WindowServer/Dock/Finder) the app can render into. A GUI app must
// be launched INTO that session (`sudo launchctl asuser <uid> …`); a plain SSH
// spawn lands in a non-GUI session. The app's --remote-debugging-port is then
// reachable over an SSH forward, and `screencapture` films the console.
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const SSHPASS = process.env.E2E_SSHPASS_BIN ?? "/opt/homebrew/bin/sshpass";
const GUEST_PASS = process.env.E2E_DESKTOP_VM_PASS ?? "admin";
const GUEST_USER = process.env.E2E_DESKTOP_VM_USER ?? "admin";
const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "LogLevel=ERROR",
  // Password auth only (sshpass): a loaded SSH agent's keys would otherwise
  // exhaust the guest's MaxAuthTries before the password is tried.
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "IdentitiesOnly=yes",
];

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const guestSsh = (
  ip: string,
  command: string,
): Promise<{ stdout: string; stderr: string }> =>
  execFileP(SSHPASS, ["-p", GUEST_PASS, "ssh", ...SSH_OPTS, `${GUEST_USER}@${ip}`, command], {
    maxBuffer: 64 * 1024 * 1024,
  });

export const guestScpFrom = (ip: string, remote: string, local: string): Promise<unknown> =>
  execFileP(SSHPASS, [
    "-p",
    GUEST_PASS,
    "scp",
    ...SSH_OPTS,
    `${GUEST_USER}@${ip}:${remote}`,
    local,
  ]);

/**
 * Push a directory into the guest by streaming a tar over ssh: one connection,
 * no per-file round-trips, and the flowing data keeps the link alive — far more
 * robust than `scp -r` of a big app bundle (thousands of files + symlinks),
 * which drops mid-transfer on a freshly-booted guest. Retries once. The dir
 * lands at `${remoteParent}/${basename(localDir)}`.
 */
export const pushDirAsTar = async (
  ip: string,
  localDir: string,
  remoteParent: string,
): Promise<void> => {
  const parent = dirname(localDir);
  const base = basename(localDir);
  const remote = `${SSHPASS} -p ${GUEST_PASS} ssh ${SSH_OPTS.join(" ")} ${GUEST_USER}@${ip} ${JSON.stringify(
    `mkdir -p ${remoteParent} && tar xf - -C ${remoteParent}`,
  )}`;
  const pipeline = `tar cf - -C ${JSON.stringify(parent)} ${JSON.stringify(base)} | ${remote}`;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: one retry over a flaky just-booted guest link
  try {
    await execFileP("sh", ["-c", pipeline], { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    await sleep(3000);
    await execFileP("sh", ["-c", pipeline], { maxBuffer: 16 * 1024 * 1024 });
  }
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

export interface Forward {
  readonly localPort: number;
  close(): void;
}

/** SSH local-forward host:localPort → guest:guestPort; resolves once it binds. */
export const guestTunnel = async (ip: string, guestPort: number): Promise<Forward> => {
  const localPort = await freePort();
  const child = spawn(
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
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: localPort }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) break;
    await sleep(500);
  }
  return { localPort, close: () => child.kill() };
};

const guestFileSize = (ip: string, remote: string): Promise<number> =>
  guestSsh(ip, `stat -f%z ${remote} 2>/dev/null || stat -c%s ${remote} 2>/dev/null || echo 0`)
    .then((r) => Number(r.stdout.trim() || "0"))
    .catch(() => 0);

/**
 * Film the guest's screen for `seconds` and land it on the host as `localMp4`
 * (mp4, plays everywhere). OS-aware capture:
 *   • macOS — `screencapture -V` to a .mov, then host-side ffmpeg to mp4. The
 *     first capture after a cold display can silently no-op, so warm it with a
 *     throwaway still and verify+retry.
 *   • linux — ffmpeg `x11grab` of the Xvfb display straight to mp4.
 * Best-effort: failures never throw — "every run is watchable" wants the video,
 * but a missing one shouldn't fail the run. Run it concurrently with the drive.
 */
export const recordGuestScreen = async (
  ip: string,
  seconds: number,
  localMp4: string,
  os: "macos" | "linux" | "windows",
): Promise<void> => {
  if (os === "windows") {
    // Windows can't screenshot the interactive desktop from an SSH session, so
    // we film the VM framebuffer directly via QEMU's `screendump` (the dockur
    // host runs the loop + ffmpeg; we pull the mp4). Host/container/storage come
    // from env (no baked-in host); best-effort, so skip filming if unconfigured.
    const host = process.env.E2E_DESKTOP_WIN_HOST;
    const storage = process.env.E2E_DESKTOP_WIN_STORAGE;
    if (!host || !storage) return;
    const container = process.env.E2E_DESKTOP_WIN_CONTAINER ?? "exec-win";
    const frames = Math.max(8, seconds * 4);
    const py = `import socket,time
s=socket.socket(socket.AF_UNIX); s.connect("/run/shm/monitor.sock"); time.sleep(0.2); s.recv(65536)
for i in range(${frames}):
    s.sendall(("screendump /storage/frames/f%03d.ppm\\n"%i).encode()); time.sleep(0.2)
    try: s.recv(65536)
    except Exception: pass`;
    const b64 = Buffer.from(py).toString("base64");
    const remote =
      `S=${storage}; rm -rf "$S/frames"; mkdir -p "$S/frames"; ` +
      `docker exec ${container} python3 -c "import base64;exec(base64.b64decode('${b64}'))"; ` +
      `ffmpeg -y -framerate 4 -i "$S/frames/f%03d.ppm" -pix_fmt yuv420p -movflags +faststart "$S/win.mp4" >/dev/null 2>&1`;
    await execFileP("ssh", ["-o", "ConnectTimeout=10", host, remote], {
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => undefined);
    await execFileP("scp", [
      "-o",
      "ConnectTimeout=10",
      `${host}:${storage}/win.mp4`,
      localMp4,
    ]).catch(() => undefined);
    return;
  }

  if (os === "linux") {
    const remote = "/tmp/executor-desktop-vm.mp4";
    await guestSsh(
      ip,
      `rm -f ${remote}; DISPLAY=:99 ffmpeg -y -f x11grab -video_size 1280x800 -framerate 15 ` +
        `-i :99 -t ${seconds} -pix_fmt yuv420p ${remote} >/tmp/ffmpeg.log 2>&1`,
    ).catch(() => undefined);
    // The mostly-flat console compresses small under x264 — a real capture is
    // ~30-60KB, a blank/failed one only a few KB.
    if ((await guestFileSize(ip, remote)) > 12_000) {
      await guestScpFrom(ip, remote, localMp4).catch(() => undefined);
    }
    return;
  }

  const remoteMov = "/tmp/executor-desktop-vm.mov";
  // Warm the capture subsystem — the first screencapture after the display comes
  // up can produce nothing.
  await guestSsh(ip, "screencapture -x /tmp/.warm.png 2>/dev/null; rm -f /tmp/.warm.png").catch(
    () => undefined,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await guestSsh(ip, `rm -f ${remoteMov}; screencapture -V ${seconds} -x ${remoteMov}`).catch(
      () => undefined,
    );
    if ((await guestFileSize(ip, remoteMov)) > 100_000) {
      const localMov = `${localMp4}.mov`;
      await guestScpFrom(ip, remoteMov, localMov).catch(() => undefined);
      await execFileP("ffmpeg", [
        "-y",
        "-i",
        localMov,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        localMp4,
      ])
        .then(() => execFileP("rm", ["-f", localMov]))
        .catch(() => undefined);
      return;
    }
  }
};

// --- a minimal CDP page client (same protocol as desktop-packaged's driver) --

interface CdpTarget {
  readonly type: string;
  readonly webSocketDebuggerUrl?: string;
}

export class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { id?: number; result?: unknown };
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)!(message.result);
        this.pending.delete(message.id);
      }
    });
  }

  static connect = (url: string): Promise<CdpPage> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: WebSocket connection promise adapter
        () => reject(new Error(`CDP connect timeout: ${url}`)),
        30_000,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpPage(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: WebSocket connection promise adapter
        reject(new Error(`CDP connect failed: ${url}`));
      });
    });

  command = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = this.nextId++;
    const result = new Promise<T>((resolve) =>
      this.pending.set(id, (value) => resolve(value as T)),
    );
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  };

  waitForText = async (text: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    const expression = `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`;
    for (;;) {
      const r = await this.command<{ result?: { value?: boolean } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (r.result?.value) return;
      // oxlint-disable-next-line executor/no-error-constructor -- boundary: a wait timeout is a plain failure here
      if (Date.now() >= deadline) throw new Error(`timed out waiting for text: ${text}`);
      await sleep(250);
    }
  };

  screenshot = async (): Promise<Buffer> => {
    const r = await this.command<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return Buffer.from(r.data, "base64");
  };

  close = (): void => this.socket.close();
}

/** The first drivable page target's WebSocket URL, fetched through the forward
 * (so the returned ws URL already points at the local port). */
export const pageWsUrl = async (localPort: number): Promise<string> => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const targets = (await fetch(`http://127.0.0.1:${localPort}/json/list`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])) as ReadonlyArray<CdpTarget>;
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: setup failure surfaced to the caller
    if (Date.now() >= deadline)
      throw new Error("no CDP page target (app not running with --remote-debugging-port?)");
    await sleep(500);
  }
};
