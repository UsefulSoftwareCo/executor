import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { RemoteAppRunner } from "@executor-js/sdk/workerd";
import type { AppDataSupervisor } from "./app-data.ts";

export class AppData extends Cloudflare.Worker<
  AppData,
  RemoteAppRunner<Effect.Effect<string>>,
  AppDataSupervisor
>()("AppData") {}

export const runnerReadsBuilds = { name: "EXECUTOR_RUNNER_READS_BUILDS", value: "1" } as const;
