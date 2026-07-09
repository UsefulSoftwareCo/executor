/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message, executor/no-error-constructor, executor/no-json-parse, executor/no-instanceof-tagged-error, executor/no-instanceof-error -- boundary: subprocess-backed bundler validates package JSON and converts worker failures into typed AppExecutorError */
import {
  createWorkerdModuleRunner,
  WORKERD_VERSION,
} from "@executor-js/runtime-workerd-subprocess";
import { Effect } from "effect";

import { AppExecutorError } from "../executor/app-tool-executor";
import type { BundleBackend, BundleOutput } from "./bundle";
import {
  driverModule,
  enforceOutputLimit,
  fileRecord,
  packageBoundaryError,
  registryOriginsFromEnv,
} from "./bundler-driver";
import type { ToolchainRef } from "./descriptor";
import { bundledWorkerBundler } from "./worker-bundler-artifact";
import { WORKER_BUNDLER_ESBUILD_VERSION, WORKER_BUNDLER_VERSION } from "./worker-bundler-version";

const workerBundlerModule = bundledWorkerBundler();

const toolchain = (): ToolchainRef => ({
  bundler: {
    name: "@cloudflare/worker-bundler",
    version: `${WORKER_BUNDLER_VERSION} (esbuild-wasm ${WORKER_BUNDLER_ESBUILD_VERSION})`,
  },
  executor: { name: "workerd-subprocess", version: WORKERD_VERSION },
  target: "es2022",
});

export const makeWorkerBundlerBackend = (): BundleBackend => ({
  toolchain,
  bundle: (input): Effect.Effect<BundleOutput, AppExecutorError> =>
    Effect.tryPromise({
      try: async () => {
        const boundaryError = packageBoundaryError(input);
        if (boundaryError) throw boundaryError;
        const modules = await workerBundlerModule;
        const token = crypto.randomUUID();
        const runner = createWorkerdModuleRunner({
          mainModule: "driver.js",
          modules: {
            "driver.js": driverModule({ token, registryOrigins: registryOriginsFromEnv() }),
            "worker-bundler.js": modules.source,
            "esbuild.wasm": { kind: "wasm", bytes: modules.wasm },
          },
          hostToken: token,
          globalOutbound: "internet",
          restartBackoffMs: 1,
        });
        try {
          const response = await runner.run<{
            readonly ok: boolean;
            readonly code?: string;
            readonly message?: string;
          }>({ files: fileRecord(input.files), entry: input.entry });
          if (!response.body.ok || typeof response.body.code !== "string") {
            throw new AppExecutorError({
              kind: "bundle",
              message: response.body.message ?? `worker-bundler failed for ${input.entry}`,
              diagnostics: [
                { path: input.entry, message: response.body.message ?? "worker-bundler failed" },
              ],
            });
          }
          const limitError = enforceOutputLimit(input.entry, response.body.code);
          if (limitError) throw limitError;
          return { code: response.body.code, toolchain: toolchain() };
        } finally {
          await runner.dispose();
        }
      },
      catch: (cause) =>
        cause instanceof AppExecutorError
          ? cause
          : new AppExecutorError({
              kind: "bundle",
              message: `worker-bundler failed for ${input.entry}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
    }),
});
