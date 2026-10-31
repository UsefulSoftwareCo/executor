/** A deployed app whose workflows use every construct the workflow diagram draws. */
import { appsManifest } from "./apps-release.ts";

export const workflowDiagramFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, router, mutation, object, userCron } from "apps";
import { newIssues, queueDigest } from "./tools";
import { triage, digest } from "./workflows";

export default defineApp({}, {
  tools: router({
    issues: router({ fresh: newIssues }),
    digest: router({ queue: queueDigest }),
    triageNow: mutation({ input: object({}) }, async (ctx) =>
      ctx.workflows.start({ workflow: "triage", input: { owner: "acme", name: "api" } })),
  }),
  workflows: { triage, digest },
  schedules: { monday: userCron({ expression: "0 8 * * 1", timezone: "UTC" }, queueDigest, {}) },
});
`,
  },
  {
    path: "tools.ts",
    content: `import { array, mutation, number, object, query, string } from "apps";

export const Repository = object({ owner: string(), name: string() });
export const newIssues = query(
  { input: Repository, output: array(object({ number: number() })) },
  async () => [],
);
export const queueDigest = mutation({ input: object({}) }, async (ctx) =>
  ctx.workflows.start({ workflow: "digest", input: { repository: "acme/api", since: "monday" } }),
);
`,
  },
  {
    path: "notify.ts",
    content: `import type { WorkflowContext } from "apps";

export async function notify(ctx: WorkflowContext) {
  await ctx.step.do("Post to Slack", async (step) => {
    await step.fetch("https://slack.com/api/chat.postMessage", { method: "POST" });
    return null;
  });
}
`,
  },
  {
    path: "workflows.ts",
    content: `import { object, string, workflow } from "apps";
import { newIssues, queueDigest, Repository } from "./tools";
import { notify } from "./notify";

export const triage = workflow(
  { description: "Label new issues and flag urgent ones", input: Repository },
  async (ctx, repo) => {
    const issues = await ctx.step.runQuery("Load new issues", newIssues, repo);
    if (issues.length === 0) return { labeled: 0 };
    for (const issue of issues) {
      if (issue.number === 0) continue;
      const label = await ctx.step.do(
        \`Classify #\${issue.number}\`,
        { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        async (step) => {
          const response = await step.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
          return String(await response.text());
        },
      );
      if (label === "urgent") await notify(ctx);
    }
    await ctx.step.runMutation("Queue the weekly digest", queueDigest, {});
    return { labeled: issues.length };
  },
);

export const digest = workflow(
  { description: "Collect a week of activity", input: object({ repository: string(), since: string() }) },
  async (ctx) => {
    await Promise.all([
      ctx.step.do("Read merged pull requests", async (step) => (await step.fetch("https://api.github.com/search/issues")).status),
      ctx.step.do("Read incidents", async (step) => (await step.fetch("https://api.pagerduty.com/incidents")).status),
    ]);
    try {
      await ctx.step.do("Send email", async (step) => (await step.fetch("https://api.resend.com/emails")).status);
    } catch {
      await ctx.step.sleep("Wait before saving a draft", "5 minutes");
    }
    return null;
  },
);
`,
  },
  appsManifest,
];
