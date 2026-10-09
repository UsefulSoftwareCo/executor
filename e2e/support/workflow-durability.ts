import { appsManifest } from "./apps-release.ts";
/** Authored app used through public HTTP to observe durable sleep and exactly-once step writes. */
export const durabilityFiles = [
  {
    path: "index.ts",
    content: `import { defineApp, workflow, query, mutation, object, string, number, router } from "apps";
const requirements = { accounts: {} };
const insert = (tx, label) => {
  const id = crypto.randomUUID();
  tx.exec("INSERT INTO events (id, label) VALUES (?, ?)", id, label);
  const read = tx.exec("SELECT label FROM events WHERE id = ?", id).one();
  if (read.label !== label) throw new Error("Insert was not visible inside its transaction");
  return { id };
};
const rows = query({ input: object({}) }, async (ctx) => ctx.sql.exec("SELECT id, label FROM events ORDER BY seq").toArray());
const save = mutation({ input: object({ label: string() }) }, async (ctx, input) =>
  ctx.sql.transaction((tx) => insert(tx, input.label)));
// The insert commits with the step's receipt; the outside calls after it may time out and retry.
const writeAndWait = mutation({ input: object({ key: string(), wait: number() }) }, async (ctx, input) => {
  const row = ctx.sql.transaction((tx) => insert(tx, input.key));
  await ctx.workflows.start({ workflow: "inserted", key: input.key, input: { key: input.key, row: row.id } });
  await new Promise((resolve) => setTimeout(resolve, input.wait));
  return row.id;
});
const inserted = workflow({ input: object({ key: string(), row: string() }) }, async (_ctx, input) => input);
// The control run uses the ordinary deadline, including cold database setup.
// Only the delayed mutation uses the short deadline that tests engine cancellation.
const write = workflow({ input: object({ key: string(), wait: number() }) }, async (ctx, input) =>
  ctx.step.runMutation("write", writeAndWait, input, { ...(input.wait > 0 ? { timeout: 2000 } : {}), retries: { limit: input.wait > 0 ? 1 : 0, delay: 0 } }));
const sleep = workflow({ input: object({ hold: number() }) }, async (ctx, input) => {
  const before = await ctx.step.runMutation("before", save, { label: "before" });
  const deadline = await ctx.step.do("deadline", async () => Date.now() + input.hold);
  await ctx.step.sleepUntil("deployment-window", deadline);
  const after = await ctx.step.runMutation("after", save, { label: "after" });
  return { before: before.id, after: after.id, deadline };
});
export default defineApp(requirements, {  tools: router({
    rows,
    save, writeAndWait,
  }), workflows: { inserted, write, sleep } });`,
  },
  {
    path: "migrations/0001_events.sql",
    content:
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, label TEXT NOT NULL);\n",
  },
  appsManifest,
];
