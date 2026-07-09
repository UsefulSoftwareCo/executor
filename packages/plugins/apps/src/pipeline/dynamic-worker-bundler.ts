/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message, executor/no-instanceof-tagged-error, executor/no-instanceof-error -- boundary: Worker Loader adapter converts bundler Worker failures into typed AppExecutorError */
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
import { WORKER_BUNDLER_ESBUILD_VERSION, WORKER_BUNDLER_VERSION } from "./worker-bundler-version";

type DynamicWorkerDefinition = {
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string | { readonly wasm: ArrayBuffer }>>;
};

export type DynamicWorkerLoaderCompatible = {
  readonly load?: (code: DynamicWorkerDefinition) => { readonly getEntrypoint: () => unknown };
  readonly get?: (
    name: string | null,
    factory: () => DynamicWorkerDefinition,
  ) => { readonly getEntrypoint: () => unknown };
};

export interface DynamicWorkerBundlerArtifact {
  readonly source: string;
  readonly wasm: ArrayBuffer;
}

export interface DynamicWorkerBundlerBackendOptions {
  readonly loader: DynamicWorkerLoaderCompatible;
  readonly artifact: () => Promise<DynamicWorkerBundlerArtifact>;
}

type BundlerResponse =
  | { readonly ok: true; readonly code: string; readonly warnings?: readonly unknown[] }
  | { readonly ok: false; readonly message?: string };

type FetchEntrypoint = {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type LoadedBundlerWorker = {
  readonly stub: { readonly getEntrypoint: () => unknown };
  readonly entrypoint: FetchEntrypoint;
};

const asFetchEntrypoint = (value: unknown): FetchEntrypoint => value as FetchEntrypoint;

const loadBundlerWorker = (
  loader: DynamicWorkerLoaderCompatible,
  artifact: DynamicWorkerBundlerArtifact,
): LoadedBundlerWorker => {
  const definition: DynamicWorkerDefinition = {
    compatibilityDate: "2025-06-01",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "driver.js",
    modules: {
      "driver.js": driverModule({ registryOrigins: registryOriginsFromEnv() }),
      "worker-bundler.js": artifact.source,
      "esbuild.wasm": { wasm: artifact.wasm },
    },
  };
  const worker =
    loader.load !== undefined
      ? loader.load(definition)
      : loader.get?.(`app-bundler-${crypto.randomUUID()}`, () => definition);
  if (worker === undefined) {
    throw new AppExecutorError({
      kind: "bundle",
      message: "Worker Loader binding does not support load() or get()",
    });
  }
  return { stub: worker, entrypoint: asFetchEntrypoint(worker.getEntrypoint()) };
};

const toolchain = (): ToolchainRef => ({
  bundler: {
    name: "@cloudflare/worker-bundler",
    version: `${WORKER_BUNDLER_VERSION} (esbuild-wasm ${WORKER_BUNDLER_ESBUILD_VERSION})`,
  },
  executor: { name: "cloud-worker", version: "worker-loader" },
  target: "es2022",
});

export const makeDynamicWorkerBundlerBackend = (
  options: DynamicWorkerBundlerBackendOptions,
): BundleBackend => {
  let artifactPromise: Promise<DynamicWorkerBundlerArtifact> | undefined;
  const artifact = () => {
    artifactPromise ??= options.artifact();
    return artifactPromise;
  };
  return {
    toolchain,
    bundle: (input): Effect.Effect<BundleOutput, AppExecutorError> =>
      Effect.tryPromise({
        try: async () => {
          const boundaryError = packageBoundaryError(input);
          if (boundaryError) throw boundaryError;
          const worker = loadBundlerWorker(options.loader, await artifact());
          const response = await worker.entrypoint.fetch("https://executor-bundler.local/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ files: fileRecord(input.files), entry: input.entry }),
          });
          const body = (await response.json()) as BundlerResponse;
          if (!body.ok) {
            const message = body.message ?? `worker-bundler failed for ${input.entry}`;
            throw new AppExecutorError({
              kind: "bundle",
              message,
              diagnostics: [{ path: input.entry, message }],
            });
          }
          const limitError = enforceOutputLimit(input.entry, body.code);
          if (limitError) throw limitError;
          return { code: body.code, toolchain: toolchain() };
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
  };
};
