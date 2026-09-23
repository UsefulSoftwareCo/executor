/**
 * Executor SDK scaffold. Each contract area keeps its model, errors and
 * operations together. Both local and remote clients share this API.
 */
import { Effect } from "effect";
import { promiseExecutor } from "./implementation/promise.ts";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import type {
  PromiseExecutor as Executor,
  ExecutorOptions,
  RemoteExecutorOptions,
} from "./contracts/executor.ts";
import {
  createExecutor as createExecutorEffect,
  createRemoteExecutor as createRemoteExecutorEffect,
} from "./implementation/create.ts";

export * from "./contracts/index.ts";
export type { PromiseExecutor as Executor } from "./contracts/executor.ts";
export {
  runtimeAdapter,
  createAppRuntime,
  type AppRuntime,
  type ResolvedAppRuntime,
} from "./implementation/runtime.ts";
export { executorDatabase } from "./implementation/storage-migrations.ts";
export { makeExecutorStorage, type ExecutorDatabase } from "./implementation/storage.ts";
/** Create an in-process Executor using caller-owned storage, runtime and credential encryption. */
export const createExecutor = (options: ExecutorOptions): Promise<Executor> =>
  Effect.runPromise(
    createExecutorEffect(options).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map(promiseExecutor),
    ),
  );

/** Create a remote Executor client. Currently rejects with NotImplemented until the transport is implemented. */
export const createRemoteExecutor = (options: RemoteExecutorOptions): Promise<Executor> =>
  Effect.runPromise(createRemoteExecutorEffect(options).pipe(Effect.map(promiseExecutor)));

export * from "./contracts/workflows.ts";
