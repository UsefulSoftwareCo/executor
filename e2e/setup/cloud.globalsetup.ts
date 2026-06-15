// Boot the cloud target for the vitest suite: claim this checkout's port
// block atomically (src/ports.ts), then run the shared boot recipe
// (cloud.boot.ts — emulated WorkOS + Autumn + the app's real dev stack, the
// same recipe the dev CLI uses). Set E2E_CLOUD_URL to attach to a running
// stack instead.
import { claimPorts } from "../src/ports";
import { E2E_COOKIE_PASSWORD, E2E_WORKOS_CLIENT_ID } from "../targets/cloud";
import { waitForHttp } from "./boot";
import { bootCloud } from "./cloud.boot";
import { bootMotel, motelExporterEnv } from "./motel";

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_CLOUD_URL) {
    await waitForHttp(process.env.E2E_CLOUD_URL);
    return;
  }

  // Claim a free port block (preferred block first, walk forward past
  // squatters/colliding checkouts) and publish via env so the test workers —
  // spawned after this — derive the same URLs. The imported targets/cloud
  // constants were computed BEFORE the claim, so use the claimed values here.
  const { ports, release } = await claimPorts([
    { envVar: "E2E_CLOUD_PORT", offset: 0, label: "cloud vite dev" },
    { envVar: "E2E_CLOUD_DB_PORT", offset: 1, label: "cloud dev-db (PGlite)" },
    { envVar: "E2E_WORKOS_EMULATOR_PORT", offset: 2, label: "WorkOS emulator" },
    { envVar: "E2E_AUTUMN_EMULATOR_PORT", offset: 3, label: "Autumn emulator" },
  ]);

  // Suite-owned trace store — every run captures distributed traces.
  const motel = await bootMotel();
  // Publish to the test workers (they inherit this process's env): scenarios
  // that assert on exported spans yield the Telemetry service, which exists
  // only when this is set. No motel → those scenarios skip, never fail.
  if (motel) process.env.E2E_MOTEL_URL = motel.url;

  const publicUrl = `http://127.0.0.1:${ports.E2E_CLOUD_PORT!}`;
  let booted;
  try {
    booted = await bootCloud({
      cloudPort: ports.E2E_CLOUD_PORT!,
      dbPort: ports.E2E_CLOUD_DB_PORT!,
      workosPort: ports.E2E_WORKOS_EMULATOR_PORT!,
      autumnPort: ports.E2E_AUTUMN_EMULATOR_PORT!,
      workosClientId: E2E_WORKOS_CLIENT_ID,
      cookiePassword: E2E_COOKIE_PASSWORD,
      publicUrl,
      // Server + browser spans → the suite's motel. The app's exporter is
      // endpoint-agnostic, so the same layer that ships prod traces to
      // Axiom ships e2e traces to the suite store — "why was that page
      // slow" gets a span waterfall, not a guess.
      extraEnv: motelExporterEnv(motel, publicUrl),
    });
  } catch (error) {
    await motel?.teardown();
    await release();
    throw error;
  }
  return async () => {
    await booted.teardown();
    await motel?.teardown();
    await release();
  };
}
