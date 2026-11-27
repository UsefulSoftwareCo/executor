import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

export type AuthoringReference = {
  readonly files: () => Effect.Effect<Readonly<Record<string, string>>, RpcCallError>;
};
