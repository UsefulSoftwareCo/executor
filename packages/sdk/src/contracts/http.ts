/** The single HTTP contract, composed from each area and projected into Executor. */
import { HttpApi } from "effect/unstable/httpapi";
import { AccountConnectionsGroup } from "./account-connection.ts";
import { AppProfilesGroup } from "./profiles.ts";
import { AccountsGroup } from "./account.ts";
import { AppsGroup } from "./apps.ts";
import { OwnersGroup } from "./owner.ts";
import { AppDataGroup } from "./app-data.ts";
import { WebhooksGroup } from "./webhooks.ts";
import { AppWorkflowsGroup, AppWorkflowRunsGroup } from "./workflows.ts";
import { SchedulesGroup } from "./schedules.ts";
import { ToolsGroup } from "./tools.ts";
import { AppSkillsGroup } from "./skills.ts";

/** The one contract artifact; everything else projects from it. */
export const ExecutorApi = HttpApi.make("executor")
  .add(AccountsGroup)
  .add(AccountConnectionsGroup)
  .add(AppsGroup)
  .add(AppProfilesGroup)
  .add(AppSkillsGroup)
  .add(ToolsGroup)
  .add(SchedulesGroup)
  .add(AppDataGroup)
  .add(WebhooksGroup)
  .add(OwnersGroup)
  .add(AppWorkflowsGroup)
  .add(AppWorkflowRunsGroup);

export type ExecutorApi = typeof ExecutorApi;
