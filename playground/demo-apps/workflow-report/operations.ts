import { query, mutation, object, string, number, array } from "apps";
import type { QueryCtx, MutationCtx } from "./context.ts";
export const reportInput = object({
  repositories: array(object({ owner: string(), name: string() })),
});
export const listReports = query({ input: object({}) }, async (ctx: QueryCtx) =>
  ctx.sql
    .exec(
      "SELECT id, repository, open_issues AS openIssues FROM reports ORDER BY created_at LIMIT 1000",
    )
    .toArray(),
);
export const saveReport = mutation(
  { input: object({ repository: string(), openIssues: number() }) },
  async (ctx: MutationCtx, input) =>
    ctx.sql.transaction((tx) =>
      tx
        .exec(
          "INSERT INTO reports (id, repository, open_issues, created_at) VALUES (?, ?, ?, ?) RETURNING id",
          crypto.randomUUID(),
          input.repository,
          input.openIssues,
          Date.now(),
        )
        .one(),
    ),
);
export const startReport = mutation({ input: reportInput }, async (ctx: MutationCtx, input) =>
  ctx.workflows.start({ workflow: "report", input }),
);
export const reportRuns = query({ input: object({}) }, async (ctx: QueryCtx) =>
  ctx.workflows.list({ workflow: "report" }),
);
