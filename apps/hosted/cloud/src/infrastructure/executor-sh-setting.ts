/** `CLOUD_EXECUTOR_SH`: who serves `executor.sh` (`executor-sh.ts`, `notes/v1-shutdown.md`). */
import { Config, Schema } from "effect";

/** v1's Workers, v2's gateway by the route only, or by the route and the custom domain. */
export const ExecutorShOwner = Schema.Literals(["v1", "route", "v2"]);
export type ExecutorShOwner = typeof ExecutorShOwner.Type;

/** Unset is `v1`: nothing is declared and v1's Workers keep the hostname. */
export const executorShSetting = Config.Literals(
  ExecutorShOwner.literals,
  "CLOUD_EXECUTOR_SH",
).pipe(Config.withDefault<ExecutorShOwner>("v1"));
