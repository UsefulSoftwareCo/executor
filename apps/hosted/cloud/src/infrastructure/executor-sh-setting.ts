import { Config, Schema } from "effect";

export const ExecutorShOwner = Schema.Literals(["v1", "route", "v2"]);
export type ExecutorShOwner = typeof ExecutorShOwner.Type;

export const executorShSetting = Config.Literals(
  ExecutorShOwner.literals,
  "CLOUD_EXECUTOR_SH",
).pipe(Config.withDefault<ExecutorShOwner>("v1"));
