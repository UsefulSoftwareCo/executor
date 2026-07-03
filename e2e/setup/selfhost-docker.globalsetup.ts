// Boot the selfhost-docker target: claim a port, then build + run the
// production image (selfhost-docker.boot.ts). Set E2E_SELFHOST_DOCKER_URL to
// attach to a running instance, or E2E_SELFHOST_DOCKER_IMAGE to test a
// published image (e.g. ghcr.io/<owner>/executor-selfhost:latest) instead of
// building from this checkout.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { claimAndBoot } from "../src/ports";
import { SELFHOST_ADMIN } from "../targets/selfhost";
import { waitForHttp } from "./boot";
import { bootSelfhostDocker } from "./selfhost-docker.boot";

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_SELFHOST_DOCKER_URL) {
    await waitForHttp(process.env.E2E_SELFHOST_DOCKER_URL);
    return;
  }

  // Claim, boot, and retry on EADDRINUSE (Linux-CI ephemeral squatter between
  // probe and bind); the claimed port is published via env for the workers.
  const { teardown } = await claimAndBoot(
    [{ envVar: "E2E_SELFHOST_DOCKER_PORT", offset: 5, label: "selfhost docker" }],
    async (ports) => {
      const port = ports.E2E_SELFHOST_DOCKER_PORT!;
      const procs = await bootSelfhostDocker({
        port,
        webBaseUrl: `http://localhost:${port}`,
        admin: SELFHOST_ADMIN,
        logFile: resolve(
          fileURLToPath(new URL("../", import.meta.url)),
          "selfhost-docker.boot.log",
        ),
      });
      return { teardown: procs.teardown, value: procs };
    },
    { label: "selfhost-docker" },
  );
  return teardown;
}
