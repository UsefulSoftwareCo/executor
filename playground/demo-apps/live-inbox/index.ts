import {
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  array,
  defineApp,
  object,
  string,
  router,
} from "apps";
import { Message } from "./schema.js";

/** The `messages` table is created by migrations/0001_messages.sql. */
const requirements = { accounts: {} };

type Row = { id: string; subject: string };

export const listMessages = query(
  { input: object({}), output: array(Message) },
  async ({ sql }: QueryContext<typeof requirements>) =>
    sql.exec<Row>("SELECT id, subject FROM messages ORDER BY created_at DESC LIMIT 100").toArray(),
);
export const receiveMessage = mutation(
  { input: object({ subject: string(), clientId: string().optional() }), output: Message },
  async ({ sql }: MutationContext<typeof requirements>, message) =>
    sql
      .exec<Row>(
        "INSERT INTO messages (id, subject, created_at) VALUES (?, ?, ?) RETURNING id, subject",
        crypto.randomUUID(),
        message.subject,
        Date.now(),
      )
      .one(),
);
export default defineApp(requirements, {
  tools: router({
    listMessages,
    receiveMessage,
  }),
});
