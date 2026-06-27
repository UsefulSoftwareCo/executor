// Suite-owned motel: a fresh local OTLP store booted alongside the target's
// dev stack (same pattern as the WorkOS/Autumn emulators) so EVERY run
// captures distributed traces — hermetically, in CI too, with no dependence
// on a machine-global daemon whose health or leftover data could leak into
// results. The raw telemetry database stays outside the publishable runs tree;
// scenario artifacts contain the portable, sanitized trace export.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bootProcesses, waitForHttp, type BootedProcesses } from "./boot";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));

export interface SuiteMotel {
  readonly url: string;
  readonly teardown: () => Promise<void>;
}

/** Boot the suite's motel server on a port claimed with the rest of the target.
 * Optional local runs can continue without it. Required trace lanes fail the
 * setup instead of turning a missing dependency into a green skip. */
export const bootMotel = async (
  port: number,
  options: { readonly required: boolean },
): Promise<SuiteMotel | null> => {
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "executor-e2e-motel-"));

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
            MOTEL_OTEL_BASE_URL: url,
            MOTEL_OTEL_DB_PATH: join(dataDir, "telemetry.sqlite"),
          },
        },
      ],
      { label: "motel" },
    );
    await procs.waitUntilReady(waitForHttp(`${url}/api/health`));
    console.log(`[e2e] traces at suite motel ${url}`);
    return {
      url,
      teardown: async () => {
        await procs?.teardown();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await procs?.teardown();
    rmSync(dataDir, { recursive: true, force: true });
    if (options.required) throw error;
    console.warn(`[e2e] optional motel unavailable, tracing off: ${String(error)}`);
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
