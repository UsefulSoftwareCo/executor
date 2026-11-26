import * as Cloudflare from "alchemy/Cloudflare";
import type { DashboardRenderer } from "../contracts/dashboard.ts";

export class Dashboard extends Cloudflare.Worker<Dashboard, DashboardRenderer>()("Dashboard") {}
