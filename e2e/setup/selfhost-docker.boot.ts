// Boot recipe for the selfhost PRODUCTION Docker artifact: build the image
// from this checkout's apps/host-selfhost/Dockerfile (or use
// E2E_SELFHOST_DOCKER_IMAGE, e.g. a published ghcr tag), then run it.
//
// The container runs with HOST networking, for the same reason the dev-server
// target sets EXECUTOR_ALLOW_LOCAL_NETWORK: scenarios boot loopback helper
// servers (OAuth test servers, MCP stubs) on the host and point the instance
// at 127.0.0.1 URLs — under bridge networking the container's loopback is a
// different universe and every one of those dials fails. Host networking
// needs Docker Engine ≥ 26 on Docker Desktop (mac/win); the boot fails loudly
// if the daemon lacks it.
//
// Data lives in a NAMED volume so the target's restart() can destroy the
// container and start a fresh one against the same data — a real deployment
// cycle (upgrade/reboot), not a warm in-place restart. The volume is removed
// in teardown — hermetic per suite, same as the dev target's fresh data dir.
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitForHttp, type BootedProcesses } from "./boot";

const exec = promisify(execFile);

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Container/volume names — derived identically by the globalsetup (boot,
 * teardown) and the target (restart), which run in different processes. */
export const selfhostDockerContainerName = (port: number): string =>
  `executor-e2e-selfhost-docker-${port}`;
export const selfhostDockerVolumeName = (port: number): string =>
  `executor-e2e-selfhost-docker-data-${port}`;

export interface SelfhostDockerBootOptions {
  readonly port: number;
  readonly webBaseUrl: string;
  readonly admin: { readonly email: string; readonly password: string };
  readonly logFile?: string;
}

const log = (file: string | undefined, text: string): void => {
  if (file) appendFileSync(file, `${text}\n`);
  else console.error(`[e2e:selfhost-docker] ${text}`);
};

/**
 * Resolve the image to run: an explicit E2E_SELFHOST_DOCKER_IMAGE wins
 * (pull-if-absent is docker's own behavior at run time); otherwise build
 * from this checkout so the suite tests the artifact the current code
 * produces. The build is the expensive step (~minutes cold, seconds warm —
 * the Dockerfile's layers cache on the lockfile), which is the cost of
 * testing what users deploy instead of a dev server.
 */
const resolveImage = async (logFile?: string): Promise<string> => {
  const pinned = process.env.E2E_SELFHOST_DOCKER_IMAGE;
  if (pinned) return pinned;
  const image = "executor-selfhost:e2e";
  log(logFile, `building ${image} from ${repoRoot}apps/host-selfhost/Dockerfile`);
  await exec("docker", ["build", "-f", "apps/host-selfhost/Dockerfile", "-t", image, "."], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => {
    log(logFile, String(error.stdout ?? ""));
    log(logFile, String(error.stderr ?? ""));
    throw new Error("selfhost-docker: image build failed — see log");
  });
  return image;
};

export interface RunContainerOptions {
  readonly image: string;
  readonly port: number;
  readonly webBaseUrl: string;
  readonly admin: { readonly email: string; readonly password: string };
  readonly logFile?: string;
}

/**
 * Start ONE container of the production image against the named data volume
 * and wait for health. Used by the suite boot and by the target's restart()
 * — a restart starts a genuinely new container, so it MUST run the exact
 * same way the boot did.
 */
export const runSelfhostContainer = async (options: RunContainerOptions): Promise<void> => {
  const name = selfhostDockerContainerName(options.port);
  const volume = selfhostDockerVolumeName(options.port);
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "host",
    "--volume",
    `${volume}:/data`,
    "-e",
    `PORT=${options.port}`,
    "-e",
    "BETTER_AUTH_SECRET=executor-selfhost-e2e-secret-0123456789",
    "-e",
    `EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=${options.admin.email}`,
    "-e",
    `EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=${options.admin.password}`,
    "-e",
    `EXECUTOR_WEB_BASE_URL=${options.webBaseUrl}`,
    // Same rationale as the dev target: the harness boots loopback MCP/OAuth
    // test servers and points the instance at them.
    "-e",
    "EXECUTOR_ALLOW_LOCAL_NETWORK=true",
    options.image,
  ];
  log(options.logFile, `docker ${args.join(" ")}`);
  await exec("docker", args).catch((error: { stderr?: string }) => {
    throw new Error(`selfhost-docker: docker run failed: ${String(error.stderr ?? error)}`);
  });

  try {
    await waitForHttp(`${options.webBaseUrl}/api/health`, { timeoutMs: 120_000 });
  } catch (error) {
    const { stdout } = await exec("docker", ["logs", "--tail", "100", name]).catch(() => ({
      stdout: "(docker logs unavailable)",
    }));
    log(options.logFile, String(stdout));
    await exec("docker", ["rm", "-f", name]).catch(() => {});
    throw error;
  }
};

/**
 * A deployment shutdown, as orchestrators do it: SIGTERM (docker stop's
 * 10s default grace, then SIGKILL), flush the container's logs, remove the
 * container. The volume stays — it's the deployment's persistent data.
 */
export const stopSelfhostContainer = async (port: number, logFile?: string): Promise<void> => {
  const name = selfhostDockerContainerName(port);
  await exec("docker", ["stop", name]).catch(() => {});
  if (logFile) {
    const { stdout } = await exec("docker", ["logs", name]).catch(() => ({ stdout: "" }));
    if (stdout) appendFileSync(logFile, stdout);
  }
  await exec("docker", ["rm", "-f", name]).catch(() => {});
};

export const bootSelfhostDocker = async (
  options: SelfhostDockerBootOptions,
): Promise<BootedProcesses> => {
  const image = await resolveImage(options.logFile);
  const name = selfhostDockerContainerName(options.port);
  const volume = selfhostDockerVolumeName(options.port);

  // A previous suite that died without teardown leaves the named container
  // and volume squatting — remove both for a hermetic boot.
  await exec("docker", ["rm", "-f", name]).catch(() => {});
  await exec("docker", ["volume", "rm", "-f", volume]).catch(() => {});

  await runSelfhostContainer({ image, ...options });

  // The target's restart() runs in a different process (test worker, not
  // globalsetup) and must re-run the same image. claimPorts-style env
  // publication: workers spawn after globalsetup, so they inherit this.
  process.env.E2E_SELFHOST_DOCKER_RESOLVED_IMAGE = image;

  return {
    teardown: async () => {
      await stopSelfhostContainer(options.port, options.logFile);
      await exec("docker", ["volume", "rm", "-f", volume]).catch(() => {});
    },
    pids: [],
  };
};
