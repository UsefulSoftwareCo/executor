import { Effect } from "effect";

import { AppExecutorError } from "../executor/app-tool-executor";
import type { ToolchainRef } from "./descriptor";

export interface BundleInput {
  readonly files: ReadonlyMap<string, string>;
  readonly entry: string;
}

export interface BundleOutput {
  readonly code: string;
  readonly toolchain?: ToolchainRef;
}

export interface BundleBackend {
  readonly bundle: (input: BundleInput) => Effect.Effect<BundleOutput, AppExecutorError>;
  readonly toolchain: () => ToolchainRef;
}

// The in-process esbuild backend must load lazily: esbuild's Node launcher
// reads process.versions at module scope, which the Cloudflare Workers
// runtime rejects at deploy validation. Hosts inject their own backend
// (native worker-bundler on cloud, workerd worker-bundler on selfhost); only
// Node-side tests and bare publish() calls reach this import.
export const defaultBundleBackend = (): Effect.Effect<BundleBackend, AppExecutorError> =>
  Effect.tryPromise({
    try: () => import("./esbuild-bundler").then((module) => module.inProcessBundleBackend()),
    catch: (cause) =>
      new AppExecutorError({
        kind: "bundle",
        message: "in-process esbuild bundle backend is unavailable in this runtime",
        cause,
      }),
  });

export const bundleEntry = (
  input: BundleInput,
  backend?: BundleBackend,
): Effect.Effect<BundleOutput, AppExecutorError> =>
  backend
    ? backend.bundle(input)
    : defaultBundleBackend().pipe(Effect.flatMap((resolved) => resolved.bundle(input)));
