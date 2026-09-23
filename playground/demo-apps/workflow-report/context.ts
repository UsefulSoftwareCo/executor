import {
  defineDatabase,
  defineProvider,
  secrets,
  table,
  object,
  string,
  number,
  type QueryContext,
  type MutationContext,
  type WorkflowContext,
} from "apps";
const github = defineProvider({
  name: "GitHub reports",
  auth: {
    token: secrets({ label: "Personal access token", fields: object({ token: string() }) }),
  },
});
/** Shared requirements determine each handler's capabilities. */
export const requirements = {
  accounts: { github },
  database: defineDatabase({ reports: table({ repository: string(), openIssues: number() }) }),
};
export type QueryCtx = QueryContext<typeof requirements>;
export type MutationCtx = MutationContext<typeof requirements>;
export type WorkflowCtx = WorkflowContext<typeof requirements>;
