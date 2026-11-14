/** Alchemy's opaque resource journal lives in the same durable object that serializes plans and applies. */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { StateStoreError, type PersistedState, type StateService } from "alchemy/State/State";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { Effect } from "effect";

const prefix = "alchemy:resource:";

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new StateStoreError({ message: "App domain resource state is unavailable" }),
  });

/**
 * Every journal row, keyed by FQN, read with one storage list. Alchemy otherwise reads each row
 * once per plan phase, which is two storage calls per team on every pass.
 */
export const appDomainJournal = (storage: DurableObjectStorage) =>
  io(() => storage.list<PersistedState>({ prefix })).pipe(
    Effect.map(
      (rows) => new Map(Array.from(rows, ([key, row]) => [key.slice(prefix.length), row] as const)),
    ),
  );

/**
 * The rows `owns` selects, as one Alchemy stack. Reads come from the journal loaded by the caller,
 * which must hold the coordinator's lock while the view is in use: this object is the journal's
 * only writer. Persist every Alchemy transition, including interrupted creates and replacements,
 * before continuing.
 */
export const appDomainState = (
  storage: DurableObjectStorage,
  journal: Map<string, PersistedState>,
  owns: (fqn: string) => boolean,
  stack: string,
  stage: string,
): StateService => {
  const key = (fqn: string) => `${prefix}${fqn}`;
  const owned = () => Array.from(journal).filter(([fqn]) => owns(fqn));
  return {
    id: "executor-app-domain-durable-object",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    listStacks: () => Effect.succeed([stack]),
    listStages: () => Effect.succeed([stage]),
    // Copies, like storage reads and writes, so Alchemy never shares an object with the journal.
    get: ({ fqn }) => {
      const row = owns(fqn) ? journal.get(fqn) : undefined;
      return Effect.succeed(row === undefined ? undefined : structuredClone(row));
    },
    set: ({ fqn, value }) =>
      io(() => storage.put(key(fqn), value)).pipe(
        Effect.map(() => {
          journal.set(fqn, structuredClone(value));
          return value;
        }),
      ),
    delete: ({ fqn }) =>
      io(() => storage.delete(key(fqn))).pipe(
        Effect.map(() => {
          journal.delete(fqn);
        }),
      ),
    list: () => Effect.succeed(owned().map(([fqn]) => fqn)),
    getReplacedResources: () =>
      Effect.succeed(
        owned().flatMap(([, row]) => (row.status === "replaced" ? [structuredClone(row)] : [])),
      ),
    deleteStack: () => {
      const fqns = owned().map(([fqn]) => fqn);
      return io(() => storage.delete([...fqns.map(key), "alchemy:output"])).pipe(
        Effect.map(() => {
          for (const fqn of fqns) journal.delete(fqn);
        }),
      );
    },
    getOutput: () => io(() => storage.get<unknown>("alchemy:output")),
    setOutput: ({ value }) => io(() => storage.put("alchemy:output", value)).pipe(Effect.as(value)),
  };
};
