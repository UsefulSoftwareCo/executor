/** Workflow authoring preserves operation types and excludes live/transaction capabilities. */
import {
  defineApp,
  defineDatabase,
  defineProvider,
  secrets,
  table,
  object,
  string,
  query,
  mutation,
  workflow,
  type WorkflowContext,
  type QueryContext,
  type MutationContext,
} from "../src/index.ts";
const service = defineProvider({
  name: "Workflow types",
  auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
});
const requirements = {
  accounts: { service },
  database: defineDatabase({ messages: table({ body: string() }) }),
};
type Ctx = WorkflowContext<typeof requirements>;
const read = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => {
  // @ts-expect-error Queries cannot start background work.
  await ctx.workflows.start({ workflow: "process", input: {} });
  // @ts-expect-error Queries cannot terminate background work.
  await ctx.workflows.terminate({ run: "other" });
  return ctx.db.messages.withIndex("by_creation").collect();
});
const write = mutation(
  { input: object({ body: string() }) },
  async (ctx: MutationContext<typeof requirements>, input) => ctx.db.messages.insert(input),
);
const process = workflow({ input: object({ body: string() }) }, async (ctx: Ctx, input) => {
  // @ts-expect-error Bodies cannot access storage.
  ctx.db;
  // @ts-expect-error Bodies cannot capture credentials.
  ctx.accounts;
  // @ts-expect-error Bodies cannot request live input.
  ctx.elicit;
  const source = await ctx.step.do("source", async (step) => {
    // @ts-expect-error External steps cannot access storage.
    step.db;
    // @ts-expect-error External steps cannot request live input.
    step.elicit;
    // @ts-expect-error External steps have only declared accounts.
    step.accounts.other;
    const token: string = step.accounts.service.fields.token;
    return token;
  });
  await ctx.step.runMutation("save", write, { body: input.body + source });
  // @ts-expect-error Inputs retain the registered operation's type.
  await ctx.step.runMutation("wrong", write, { body: 1 });
  // @ts-expect-error A mutation cannot be invoked as a query.
  await ctx.step.runQuery("wrong", write, { body: "x" });
  const values = await ctx.step.runQuery("read", read, {});
  const text: string | undefined = values[0]?.body;
  return text;
});
defineApp(requirements, {
  queries: { read },
  mutations: { write },
  workflows: { process },
});
// @ts-expect-error The workflow's operation context requires its declared database and accounts.
defineApp({ accounts: {} }, { workflows: { process } });
