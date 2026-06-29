// Suite-owned motel: a fresh local OTLP store booted alongside the target's
// dev stack (same pattern as the WorkOS/Autumn emulators) so EVERY run
// captures distributed traces — hermetically, in CI too, with no dependence
// on a machine-global daemon whose health or leftover data could leak into
// results. DB lives under runs/.motel so the suite's evidence stays with
// the suite; wiped per boot like the target's dev DB.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bootProcesses, waitForHttp, type BootedProcesses } from "./boot";

export const MOTEL_PORT = 4796;
export const MOTEL_URL = `http://127.0.0.1:${MOTEL_PORT}`;

const e2eDir = fileURLToPath(new URL("..", import.meta.url));

export interface SuiteMotel {
  readonly url: string;
  readonly teardown: () => Promise<void>;
}

/** Boot the suite's motel server. Never fails the suite: if the binary or
 *  the port is unavailable, tracing is simply off (null) and targets skip
 *  the exporter env. */
export const bootMotel = async (): Promise<SuiteMotel | null> => {
  const dataDir = join(e2eDir, "runs", ".motel");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  let procs: BootedProcesses | null = null;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: optional infrastructure; a motel-less host still runs the suite
  try {
    procs = bootProcesses(
      [
        {
          cmd: "bunx",
          args: ["motel", "server"],
          cwd: e2eDir,
          env: {
            MOTEL_OTEL_BASE_URL: MOTEL_URL,
            MOTEL_OTEL_DB_PATH: join(dataDir, "telemetry.sqlite"),
          },
        },
      ],
      { label: "motel" },
    );
    await waitForHttp(`${MOTEL_URL}/api/health`);
    console.log(`[e2e] traces → suite motel at ${MOTEL_URL}`);
    return { url: MOTEL_URL, teardown: procs.teardown };
  } catch (error) {
    console.warn(`[e2e] motel unavailable, tracing off: ${String(error)}`);
    await procs?.teardown();
    return null;
  }
};

/** Exporter env for a target's dev stack: server spans via the app's
 *  endpoint-agnostic Axiom exporter, browser spans via packages/react's
 *  OTLP tracer (same-origin /v1/traces, proxied by the dev server — motel
 *  serves no CORS headers). */
export const motelExporterEnv = (
  motel: SuiteMotel | null,
  appBaseUrl: string,
): Record<string, string> =>
  motel
    ? {
        AXIOM_TRACES_URL: `${motel.url}/v1/traces`,
        AXIOM_TOKEN: "motel-local",
        AXIOM_DATASET: "executor-e2e",
        VITE_PUBLIC_OTLP_TRACES_URL: `${appBaseUrl}/v1/traces`,
        MOTEL_URL: motel.url,
      }
    : {};
