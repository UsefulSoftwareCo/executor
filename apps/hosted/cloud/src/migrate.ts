import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { migrateCloudDatabase } from "./implementation/migrations.ts";

NodeRuntime.runMain(migrateCloudDatabase);
