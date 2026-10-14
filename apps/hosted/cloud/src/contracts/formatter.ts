/** The private binding to the Worker that formats source for display. */
import type { SourceTextFile as SourceFile } from "@executor-js/sdk/core";
import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

/** Formatting fails only with transport failures; a file that cannot be parsed keeps its text. */
export type SourceFormat = {
  readonly format: (
    files: ReadonlyArray<SourceFile>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<SourceFile>, RpcCallError>;
};
