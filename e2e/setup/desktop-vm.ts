// Shared plumbing for the desktop-<os> globalsetups. Each OS setup supplies a
// `provision` that boots its guest and brings the packaged app up with
// --remote-debugging-port; this module handles the rest the same everywhere:
// attach to an already-running guest (E2E_DESKTOP_VM_IP) or provision a fresh
// one, then forward the guest's CDP port and publish it for the scenario.
import { guestTunnel } from "../src/vm/desktop";
import type { VmHandle } from "../src/vm/types";

export const CDP_GUEST_PORT = 9222;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until an HTTP endpoint inside the guest answers (any status — a 401 from
 * the bearer-gated daemon still means "up"). HTTP, not lsof: the app may be
 * owned by root (launchctl asuser), whose listening socket an unprivileged lsof
 * can't see — a loopback HTTP probe works regardless of owner. */
export const waitGuestHttp = async (vm: VmHandle, url: string, attempts = 60): Promise<boolean> => {
  for (let i = 0; i < attempts; i++) {
    const r = await vm.ssh(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${url} 2>/dev/null || echo 000`,
    );
    const code = r.stdout.trim().slice(-3);
    if (code !== "000" && code !== "") return true;
    await sleep(2000);
  }
  return false;
};

/** Poll until CDP advertises a real PAGE target — i.e. the app's window/renderer
 * is up, not just the browser endpoint. On a cold guest the page appears a good
 * bit after the port opens, so gating on this makes the scenario deterministic. */
export const waitGuestPageTarget = async (
  vm: VmHandle,
  port: number,
  attempts = 60,
): Promise<boolean> => {
  for (let i = 0; i < attempts; i++) {
    const r = await vm.ssh(
      `curl -s --max-time 5 http://127.0.0.1:${port}/json/list 2>/dev/null | grep -c '"type": "page"' || echo 0`,
    );
    if (Number(r.stdout.trim() || "0") > 0) return true;
    await sleep(2000);
  }
  return false;
};

export interface ProvisionedGuest {
  readonly ip: string;
  readonly teardown: () => Promise<void>;
}

/**
 * The body every desktop-<os>.globalsetup returns: attach to E2E_DESKTOP_VM_IP
 * if set, else provision a fresh guest; then forward the guest's CDP port and
 * publish it (+ the guest IP, for filming) for the worker. A provision/forward
 * failure never fails the run — the scenario skips honestly, like
 * desktop-packaged without a display.
 */
export const attachOrProvision = async (
  provision: () => Promise<ProvisionedGuest>,
): Promise<(() => Promise<void>) | void> => {
  let ip = process.env.E2E_DESKTOP_VM_IP;
  let teardownVm: (() => Promise<void>) | undefined;

  if (!ip) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: VM/host setup may fail; degrade to a skip
    try {
      const result = await provision();
      ip = result.ip;
      teardownVm = result.teardown;
    } catch (error) {
      console.warn(`[desktop] provision failed, scenario will skip: ${String(error)}`);
      return;
    }
  }

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: forwarding may fail; degrade to a skip
  try {
    const forward = await guestTunnel(ip, CDP_GUEST_PORT);
    process.env.E2E_DESKTOP_CDP_PORT = String(forward.localPort);
    process.env.E2E_DESKTOP_VM_IP = ip;
    return async () => {
      forward.close();
      await teardownVm?.();
    };
  } catch (error) {
    console.warn(`[desktop] could not forward CDP from ${ip}: ${String(error)}`);
    await teardownVm?.();
    return;
  }
};
