import * as Cloudflare from "alchemy/Cloudflare";
import type { AppDomainCoordinator } from "./app-domains.ts";

export class AppDomainController extends Cloudflare.Worker<
  AppDomainController,
  {},
  AppDomainCoordinator
>()("AppDomainController") {}
