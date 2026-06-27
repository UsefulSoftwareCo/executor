// Boot the Cloudflare target: claim this checkout's port atomically, then run
// the shared boot recipe (cloudflare.boot.ts). Attach mode requires both
// E2E_CLOUDFLARE_URL and E2E_CLOUDFLARE_ACCESS_URL because the full auth suite
// needs the issuer's token-minting and ledger capabilities.
import {
  accessAssertionHeaders,
  verifyCloudflareAccessEmulator,
} from "../src/cloudflare-access-emulator";
import { claimPorts } from "../src/ports";
import { targetBootMode, waitForHttp } from "./boot";
import { bootCloudflare } from "./cloudflare.boot";

export const requiredCloudflareAccessAttachUrl = (
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const accessMode = targetBootMode("E2E_CLOUDFLARE_ACCESS_URL", env);
  if (accessMode.kind !== "attach") {
    throw new Error(
      "e2e: Cloudflare attach mode requires E2E_CLOUDFLARE_ACCESS_URL with the test issuer, token minting, and ledger endpoints; a static token alone cannot run the full auth suite",
    );
  }
  return accessMode.url;
};

export default async function setup(): Promise<(() => Promise<void>) | void> {
  const mode = targetBootMode("E2E_CLOUDFLARE_URL");
  if (mode.kind === "attach") {
    const accessUrl = requiredCloudflareAccessAttachUrl();
    process.env.E2E_CLOUDFLARE_URL = mode.url;
    process.env.E2E_CLOUDFLARE_ACCESS_URL = accessUrl;
    const verified = await verifyCloudflareAccessEmulator(accessUrl);
    await waitForHttp(`${mode.url}/api/account/me`, {
      expectedStatus: 200,
      headers: accessAssertionHeaders(verified.token),
    });
    return;
  }

  const { ports, release } = await claimPorts([
    { envVar: "E2E_CLOUDFLARE_PORT", offset: 6, label: "cloudflare wrangler dev" },
    {
      envVar: "E2E_CLOUDFLARE_ACCESS_PORT",
      offset: 7,
      label: "cloudflare Access issuer",
    },
  ]);
  const port = ports.E2E_CLOUDFLARE_PORT!;
  const accessPort = ports.E2E_CLOUDFLARE_ACCESS_PORT!;

  let procs;
  try {
    procs = await bootCloudflare({ port, accessPort });
  } catch (error) {
    await release();
    throw error;
  }
  return async () => {
    await procs.teardown();
    await release();
  };
}
