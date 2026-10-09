import {
  defineApp,
  string,
  object,
  interval,
  cron,
  mutation,
  query,
  type MutationContext,
  type QueryContext,
  router,
} from "apps";
import { always } from "apps/operations/approval";

/** The `notes` table is created by migrations/0001_notes.sql. */
const requirements = { accounts: {} };
const record = mutation(
  { input: object({ message: string() }), approval: always() },
  async (ctx: MutationContext<typeof requirements>, input) =>
    ctx.sql
      .exec(
        "INSERT INTO notes (id, message, created_at) VALUES (?, ?, ?) RETURNING id, message",
        crypto.randomUUID(),
        input.message,
        Date.now(),
      )
      .one(),
);
const list = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) =>
  ctx.sql.exec("SELECT id, message FROM notes ORDER BY created_at LIMIT 100").toArray(),
);

export default defineApp(requirements, {
  tools: router({
    list,
    record,
  }),
  schedules: {
    heartbeat: interval({ minutes: 5 }, record, { message: "Heartbeat" }),
    morning: cron({ expression: "0 9 * * MON-FRI", timezone: "America/Los_Angeles" }, record, {
      message: "Good morning",
    }),
  },
});
