/** The default management app is assembled only when its owning organization needs it. */
import { organizationDefaults } from "@executor-js/hosted-server";
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import type { Executor, ExecutorDatabase } from "@executor-js/sdk/core";
import authoring from "../../.generated/executor-authoring.json" with { type: "json" };
import { executorCloudApiDocument } from "../contracts/api.ts";

/** Load the management contract and authoring material behind this feature's module boundary. */
export const defaultApp = (executor: Executor, origin: string, storage: ExecutorDatabase) =>
  organizationDefaults(
    executor,
    origin,
    storage,
    executorSkillFiles(authoring),
    executorCloudApiDocument(origin),
  );
