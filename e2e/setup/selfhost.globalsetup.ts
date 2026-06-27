// Boot the selfhost target: claim this checkout's port atomically
// (src/ports.ts), then run the shared boot recipe (selfhost.boot.ts — the
// same one the dev CLI uses). Set E2E_SELFHOST_URL to attach to a running
// instance (with E2E_SELFHOST_ADMIN_EMAIL/PASSWORD matching it).
import { claimPorts } from "../src/ports";
import { SELFHOST_ADMIN } from "../targets/selfhost";
import { targetBootMode, waitForHttp } from "./boot";
import { bootSelfhost } from "./selfhost.boot";

export default async function setup(): Promise<(() => Promise<void>) | void> {
  const mode = targetBootMode("E2E_SELFHOST_URL");
  if (mode.kind === "attach") {
    process.env.E2E_SELFHOST_URL = mode.url;
    await waitForHttp(`${mode.url}/api/health`, {
      expectedStatus: 200,
      validateResponse: async (response) => {
        const body: unknown = await response.json();
        return (
          typeof body === "object" && body !== null && "status" in body && body.status === "ok"
        );
      },
    });
    return;
  }

  // Claim a free port (preferred block first, walk forward past squatters)
  // and publish via env so the test workers derive the same URL. The imported
  // targets/selfhost constants were computed BEFORE the claim — don't use
  // them for ports/URLs here.
  const { ports, release } = await claimPorts([
    { envVar: "E2E_SELFHOST_PORT", offset: 4, label: "selfhost vite dev" },
  ]);
  const port = ports.E2E_SELFHOST_PORT!;

  // Fresh data dir per suite run — hermetic; in-suite isolation comes from
  // fresh identities, not resets (bootSelfhost wipes it).
  let procs;
  try {
    procs = await bootSelfhost({
      port,
      webBaseUrl: `http://localhost:${port}`,
      admin: SELFHOST_ADMIN,
    });
  } catch (error) {
    await release();
    throw error;
  }
  return async () => {
    await procs.teardown();
    await release();
  };
}
