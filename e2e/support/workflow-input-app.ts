/** An ordinary authored app asks, records one continuation and keeps consent separate. */
import { appsManifest } from "./apps-release.ts";
export const workflowInputFiles = [
  appsManifest,
  {
    path: "index.ts",
    content: `import { defineApp, workflow, query, mutation, object, string, number, router } from "apps";
const rows = query({ input: object({}) }, async (ctx) => ctx.sql.exec("SELECT question, answer FROM receipts ORDER BY question").toArray());
const save = mutation({ input: object({ question: string(), answer: string() }) }, async (ctx, input) => {
  ctx.sql.transaction((tx) => tx.exec("INSERT INTO receipts (question, answer) VALUES (?, ?)", input.question, input.answer));
  return null;
});
const protectedAction = mutation({ input: object({}), approval: () => "user-approval" }, async () => "must not run");
const ask = workflow({ input: object({ timeoutMs: number(), protected: string() }) }, async (ctx, input) => {
  const question = await ctx.step.requestInput("choose", {
    timeoutMs: input.timeoutMs,
    form: { mode: "form", message: "Choose a synthetic action", requestedSchema: {
      type: "object", properties: { choice: { type: "string", enum: ["continue", "defer"] } }, required: ["choice"],
    } },
    evidence: [{ label: "Origin", value: "synthetic" }],
    links: [{ label: "Open Accounts", href: "/accounts" }],
  });
  const result = await ctx.step.waitForInput("answer", question);
  if (result.status === "answered" && result.response.action === "accept") {
    await ctx.step.runMutation("record", save, { question: question.id, answer: String(result.response.content?.choice) });
    if (input.protected === "yes") await ctx.step.runMutation("protected", protectedAction, {});
  }
  return result;
});
const many = workflow({ input: object({ timeoutMs: number(), protected: string() }) }, async (ctx, input) => {
  let last;
  for (let index = 0; index < 105; index++) last = await ctx.step.requestInput("question " + index, {
    timeoutMs: input.timeoutMs,
    form: { mode: "form", message: "A synthetic paginated question", requestedSchema: { type: "object", properties: {} } },
  });
  return ctx.step.waitForInput("wait", last);
});
export default defineApp({}, { tools: router({ rows, save, protectedAction }), workflows: { ask, many } });`,
  },
  {
    path: "migrations/0001_receipts.sql",
    content: "CREATE TABLE receipts (question TEXT PRIMARY KEY, answer TEXT NOT NULL);",
  },
];
