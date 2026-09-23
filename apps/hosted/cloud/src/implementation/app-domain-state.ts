/** Alchemy's opaque resource journal lives in the same durable object that serializes plans and applies. */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { StateStoreError, type PersistedState, type StateService } from "alchemy/State/State";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { Effect } from "effect";

/** Persist every Alchemy transition, including interrupted creates and replacements, before continuing. */
export const appDomainState = (
  storage: DurableObjectStorage,
  stack: string,
  stage: string,
): StateService => {
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () => new StateStoreError({ message: "App domain resource state is unavailable" }),
    });
  const key = (fqn: string) => `alchemy:resource:${fqn}`;
  const entries = () => io(() => storage.list<PersistedState>({ prefix: "alchemy:resource:" }));
  return {
    id: "executor-app-domain-durable-object",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    listStacks: () => Effect.succeed([stack]),
    listStages: () => Effect.succeed([stage]),
    get: ({ fqn }) => io(() => storage.get<PersistedState>(key(fqn))),
    set: ({ fqn, value }) => io(() => storage.put(key(fqn), value)).pipe(Effect.as(value)),
    delete: ({ fqn }) => io(() => storage.delete(key(fqn))).pipe(Effect.asVoid),
    list: () =>
      entries().pipe(
        Effect.map((rows) => Array.from(rows.keys(), (k) => k.slice("alchemy:resource:".length))),
      ),
    getReplacedResources: () =>
      entries().pipe(
        Effect.map((rows) => Array.from(rows.values()).filter((row) => row.status === "replaced")),
      ),
    deleteStack: () =>
      entries().pipe(
        Effect.flatMap((rows) => io(() => storage.delete([...rows.keys(), "alchemy:output"]))),
        Effect.asVoid,
      ),
    getOutput: () => io(() => storage.get<unknown>("alchemy:output")),
    setOutput: ({ value }) => io(() => storage.put("alchemy:output", value)).pipe(Effect.as(value)),
  };
};
