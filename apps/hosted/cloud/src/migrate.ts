/** Explicit Node migration job for cloud Postgres; never runs inside the Worker. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { migrateCloudDatabase } from "./implementation/migrations.ts";

NodeRuntime.runMain(migrateCloudDatabase);
