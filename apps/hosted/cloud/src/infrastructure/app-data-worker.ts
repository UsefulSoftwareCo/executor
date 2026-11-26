import * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { RemoteAppRunner } from "@executor-js/sdk/workerd";
import type { AppDataSupervisor } from "./app-data.ts";
import type { AppCluster } from "./app-cluster.ts";

export class AppData extends Cloudflare.Worker<
  AppData,
  RemoteAppRunner<Effect.Effect<string>>,
  AppDataSupervisor | AppCluster
>()("AppData") {}

export const runnerReadsBuilds = { name: "EXECUTOR_RUNNER_READS_BUILDS", value: "1" } as const;
