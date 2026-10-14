/** The private binding to the Worker that holds the Executor authoring reference. */
import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

/** The skill documents and `framework-reference.json`, keyed by path, as the build generated them. */
export type AuthoringReference = {
  readonly files: () => Effect.Effect<Readonly<Record<string, string>>, RpcCallError>;
};
