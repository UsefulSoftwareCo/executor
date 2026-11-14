/** The private binding to the Worker that formats source for display and reads authored Markdown. */
import type { MarkdownRefusals, SourceTextFile as SourceFile } from "@executor-js/sdk/core";
import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

export type Formatting = {
  /** Formatting fails only with transport failures; a file that cannot be parsed keeps its text. */
  readonly format: (
    files: ReadonlyArray<SourceFile>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<SourceFile>, RpcCallError>;
  /** What the connect form would not show in each text, in order; see `MarkdownReader`. */
  readonly markdown: (
    texts: ReadonlyArray<string>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<MarkdownRefusals>, RpcCallError>;
};
