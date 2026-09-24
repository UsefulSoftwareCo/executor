/** Lazy operation discovery and resolution. Executables remain invocation-owned. */
import type { Effect } from "effect";
import type { HostedTool } from "./host.ts";
import type { AppOperation } from "./operations.ts";

/** Tool names include their queries./mutations. prefix. Resolution never requires listing. */
export interface DynamicTools {
  readonly list: () => Effect.Effect<readonly HostedTool[], unknown>;
  readonly resolve: (name: string) => Effect.Effect<AppOperation | undefined, unknown>;
}
