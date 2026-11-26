import type { MarkdownRefusals, SourceTextFile as SourceFile } from "@executor-js/sdk/core";
import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

export type Formatting = {
  readonly format: (
    files: ReadonlyArray<SourceFile>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<SourceFile>, RpcCallError>;
  readonly markdown: (
    texts: ReadonlyArray<string>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<MarkdownRefusals>, RpcCallError>;
};
