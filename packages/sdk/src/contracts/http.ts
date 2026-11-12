/** The single HTTP contract, composed from each area and projected into Executor. */
import { HttpApi } from "effect/http-api";
import { AccountConnectionsGroup } from "./account-connection.ts";
import { OAuthClientsGroup } from "./oauth-clients.ts";
import { AccountsGroup } from "./account.ts";
import { AppsGroup } from "./apps.ts";
import { OwnersGroup } from "./owner.ts";
import { AppDataGroup } from "./app-data.ts";
import { WebhooksGroup } from "./webhooks.ts";
import { AppWorkflowsGroup, AppWorkflowRunsGroup } from "./workflows.ts";
import { SchedulesGroup } from "./schedules.ts";
import { ToolsGroup } from "./tools.ts";
import { AppSkillsGroup } from "./skills.ts";
import { PublicationsGroup, RegistryGroup } from "./publications.ts";
import { RequestRejection } from "./shared.ts";

/** The one contract artifact; everything else projects from it. Every endpoint declares request rejections. */
export const ExecutorApi = HttpApi.make("executor")
  .add(AccountsGroup)
  .add(AccountConnectionsGroup)
  .add(OAuthClientsGroup)
  .add(AppsGroup)
  .add(AppSkillsGroup)
  .add(ToolsGroup)
  .add(SchedulesGroup)
  .add(AppDataGroup)
  .add(WebhooksGroup)
  .add(OwnersGroup)
  .add(AppWorkflowsGroup)
  .add(AppWorkflowRunsGroup)
  .add(PublicationsGroup)
  .add(RegistryGroup)
  .middleware(RequestRejection);

export type ExecutorApi = typeof ExecutorApi;
