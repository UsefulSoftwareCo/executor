import type { Executor, StorageError } from "@executor-js/sdk/core";
import { Context, type Effect } from "effect";

/** Resolve the public SDK on demand. The host owns its lifetime: a cloud request or the self-host process. */
export class HostedExecutor extends Context.Service<
  HostedExecutor,
  Effect.Effect<Executor, StorageError>
>()("hosted/Executor") {}
