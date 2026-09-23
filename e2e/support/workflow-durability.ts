/** Authored app used through public HTTP to observe durable sleep and confirmed timeout writes. */
export const durabilityFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, defineDatabase, table, workflow, query, mutation, object, string, number } from "apps";
const requirements = { accounts: {}, database: defineDatabase({ events: table({ label: string() }) }) };
const rows = query({ input: object({}) }, async (ctx) => ctx.db.events.withIndex("by_creation").collect());
const save = mutation({ input: object({ label: string() }) }, async (ctx, input) => ctx.db.events.insert(input));
const writeAndWait = mutation({ input: object({ key: string(), wait: number() }) }, async (ctx, input) => {
  const row = await ctx.db.events.insert({ label: input.key });
  const read = await ctx.db.events.get(row.id);
  if (read?.label !== input.key) throw new Error("Insert was not visible inside its transaction");
  await ctx.workflows.start({ workflow: "inserted", key: input.key, input: { key: input.key, row: row.id } });
  await new Promise((resolve) => setTimeout(resolve, input.wait));
  return row.id;
});
const inserted = workflow({ input: object({ key: string(), row: string() }) }, async (_ctx, input) => input);
const write = workflow({ input: object({ key: string(), wait: number() }) }, async (ctx, input) =>
  ctx.step.runMutation("write", writeAndWait, input, { timeout: 5000, retries: { limit: 0, delay: 0 } }));
const sleep = workflow({ input: object({ hold: number() }) }, async (ctx, input) => {
  const before = await ctx.step.runMutation("before", save, { label: "before" });
  const deadline = await ctx.step.do("deadline", async () => Date.now() + input.hold);
  await ctx.step.sleepUntil("deployment-window", deadline);
  const after = await ctx.step.runMutation("after", save, { label: "after" });
  return { before: before.id, after: after.id, deadline };
});
export default defineApp(requirements, {  queries: { rows }, mutations: { save, writeAndWait }, workflows: { inserted, write, sleep } });`,
  },
];
