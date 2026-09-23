import {
  defineApp,
  defineDatabase,
  table,
  string,
  object,
  interval,
  cron,
  mutation,
  query,
  type MutationContext,
  type QueryContext,
} from "apps";
import { always } from "apps/operations/approval";

const database = defineDatabase({ notes: table({ message: string() }) });
const requirements = { accounts: {}, database };
const record = mutation(
  { input: object({ message: string() }), approval: always() },
  async (ctx: MutationContext<typeof requirements>, input) => ctx.db.notes.insert(input),
);
const list = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.db.notes.withIndex("by_creation").take(100),
);

export default defineApp(requirements, {
  queries: { list },
  mutations: { record },
  schedules: {
    heartbeat: interval({ minutes: 5 }, record, { message: "Heartbeat" }),
    morning: cron({ expression: "0 9 * * MON-FRI", timezone: "America/Los_Angeles" }, record, {
      message: "Good morning",
    }),
  },
});
