/** Lazy operation discovery and resolution. Executables remain invocation-owned. */
import type { Effect } from "effect";
import type { HostedTool, HostedToolSummary } from "./host.ts";
import type { AppOperation } from "./operations.ts";

/** Tool names include their queries./mutations. prefix. Resolution never requires listing. */
export interface DynamicTools {
  readonly list: () => Effect.Effect<readonly HostedTool[], unknown>;
  readonly resolve: (name: string) => Effect.Effect<AppOperation | undefined, unknown>;
  /** Names and descriptions without schemas. Omitted sources reduce list(). */
  readonly summaries?: () => Effect.Effect<readonly HostedToolSummary[], unknown>;
  /** One tool's full metadata without listing. Omitted sources search list(). */
  readonly describe?: (name: string) => Effect.Effect<HostedTool | undefined, unknown>;
}
