// Boot the Cloudflare target: claim this checkout's port atomically, then run
// the shared boot recipe (cloudflare.boot.ts). Set E2E_CLOUDFLARE_URL to attach
// to an already-running instance instead.
import { claimPorts } from "../src/ports";
import { waitForHttp } from "./boot";
import { bootCloudflare } from "./cloudflare.boot";

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_CLOUDFLARE_URL) {
    await waitForHttp(`${process.env.E2E_CLOUDFLARE_URL}/api/account/me`);
    return;
  }

  const { ports, release } = await claimPorts([
    { envVar: "E2E_CLOUDFLARE_PORT", offset: 5, label: "cloudflare wrangler dev" },
  ]);
  const port = ports.E2E_CLOUDFLARE_PORT!;

  let procs;
  try {
    procs = await bootCloudflare({ port });
  } catch (error) {
    await release();
    throw error;
  }
  return async () => {
    await procs.teardown();
    await release();
  };
}
