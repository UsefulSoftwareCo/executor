import { defineHook } from "workflow";
import { automationApprovalDecisionSchema } from "./types";

export const automationApprovalHook = defineHook({
  schema: automationApprovalDecisionSchema,
});
