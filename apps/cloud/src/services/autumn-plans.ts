import { team } from "../../autumn.config";

export const PAID_AUTUMN_PLAN_IDS = new Set([team.id]);

export const ACTIVE_AUTUMN_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
