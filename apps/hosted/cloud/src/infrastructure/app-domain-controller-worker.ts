import * as Cloudflare from "alchemy/Cloudflare";
import type { AppDomainCoordinator } from "./app-domains.ts";
import type { PreviewActivity } from "./preview-activity.ts";

export class AppDomainController extends Cloudflare.Worker<
  AppDomainController,
  {},
  AppDomainCoordinator | PreviewActivity
>()("AppDomainController") {}
