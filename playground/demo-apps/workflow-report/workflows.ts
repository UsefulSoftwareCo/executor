import { workflow, object, number, NonRetryableError } from "apps";
import type { WorkflowCtx } from "./context.ts";
import { reportInput, saveReport, listReports } from "./operations.ts";
const repositoryResponse = object({ open_issues_count: number() });
/** Independent reads run together; every database write uses its registered mutation. */
export const report = workflow({ input: reportInput }, async (ctx: WorkflowCtx, input) => {
  const reports = await Promise.all(
    input.repositories.map(async ({ owner, name }) => {
      const repository = `${owner}/${name}`;
      const openIssues = await ctx.step.do(
        `fetch ${repository}`,
        {
          retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
          timeout: "30 seconds",
        },
        async (step) => {
          const response = await step.fetch(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
            {
              headers: {
                Authorization: `Bearer ${step.accounts.github.fields.token}`,
                "User-Agent": "Executor reports",
                Accept: "application/vnd.github+json",
              },
            },
          );
          if (response.status === 404) throw new NonRetryableError("Repository not found");
          if (!response.ok) throw new Error("Repository request failed");
          return repositoryResponse.parse(await response.json()).open_issues_count;
        },
      );
      return { repository, openIssues };
    }),
  );
  for (const report of reports)
    await ctx.step.runMutation(`save ${report.repository}`, saveReport, report);
  return ctx.step.runQuery("saved reports", listReports, {});
});
