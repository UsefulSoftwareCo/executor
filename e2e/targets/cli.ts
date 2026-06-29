// The supervised local CLI daemon as a target. `executor service install` boots
// an OS-managed daemon (launchd / systemd / Task Scheduler) inside a guest VM;
// `restart()` reboots that guest for REAL, so restart-persistence proves the
// boot-time auto-start path (RunAtLoad / linger / AtStartup), not just a process
// restart. The guest daemon binds loopback, so globalsetup forwards it to a
// local port over a reconnecting SSH tunnel — making target.baseUrl work
// unchanged for the api surface. Boot + tunnel live in setup/cli.globalsetup.ts;
// this target only reads what that published via env.
import { Effect } from "effect";

import { waitForHttp, waitForHttpDown } from "../setup/boot";
import { ec2RebootGuest } from "../src/vm/ec2";
import { sshRebootGuest } from "../src/vm/tart";
import type { VmOs } from "../src/vm/types";
import type { Capability, Identity, Target } from "../src/target";

const env = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`cli target: ${key} not set — did cli.globalsetup run?`);
  return value;
};

export const cliTarget = (): Target => {
  const baseUrl = env("E2E_CLI_BASE_URL");
  const os = (process.env.E2E_VM_OS ?? "macos") as VmOs;

  return {
    name: process.env.E2E_TARGET ?? "cli",
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    capabilities: new Set<Capability>(["api"]),
    // The supervised daemon is bearer-gated (auth.json); globalsetup reads the
    // token from the guest and publishes it. A wrong/absent token still gets a
    // clean 401, which the api surface treats as "up".
    newIdentity: () =>
      Effect.sync(
        (): Identity => ({
          label: "cli-daemon",
          headers: { Authorization: `Bearer ${env("E2E_CLI_AUTH_TOKEN")}` },
        }),
      ),
    // A genuine machine reboot, not a service kick: reboot the guest OS, GATE on
    // the daemon actually going down (an orderly shutdown serves for several
    // seconds + the reconnecting tunnel re-forwards, so "reachable" right after
    // the reboot command would false-pass), then wait for the supervised daemon
    // to auto-start and serve again — proving the boot-time auto-start path.
    restart: () =>
      Effect.promise(async () => {
        const host = env("E2E_CLI_VM_HOST");
        if (os === "windows") {
          await ec2RebootGuest(host, env("E2E_CLI_SSH_KEY"), os);
        } else {
          await sshRebootGuest(host);
        }
        await waitForHttpDown(`${baseUrl}/`, { timeoutMs: 120_000 });
        await waitForHttp(`${baseUrl}/`, { timeoutMs: 240_000 });
      }),
  };
};
