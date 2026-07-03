// Boot the Cloudflare target: claim this checkout's port atomically, then run
// the shared boot recipe (cloudflare.boot.ts). Set E2E_CLOUDFLARE_URL to attach
// to an already-running instance instead.
import { claimAndBoot } from "../src/ports";
import { waitForHttp } from "./boot";
import { bootCloudflare } from "./cloudflare.boot";

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_CLOUDFLARE_URL) {
    await waitForHttp(`${process.env.E2E_CLOUDFLARE_URL}/api/account/me`);
    return;
  }

  // Claim, boot, and retry on EADDRINUSE (Linux-CI ephemeral squatter between
  // probe and bind); the claimed port is published via env for the workers.
  const { teardown } = await claimAndBoot(
    [{ envVar: "E2E_CLOUDFLARE_PORT", offset: 5, label: "cloudflare wrangler dev" }],
    async (ports) => {
      const procs = await bootCloudflare({ port: ports.E2E_CLOUDFLARE_PORT! });
      return { teardown: procs.teardown, value: procs };
    },
    { label: "cloudflare" },
  );
  return teardown;
}
