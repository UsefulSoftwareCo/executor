import {
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  array,
  defineApp,
  defineDatabase,
  object,
  string,
  table,
} from "apps";
import { Message } from "./schema.ts";

const database = defineDatabase({
  messages: table({ subject: string() }).index("by_subject", ["subject"]),
});

const requirements = { accounts: {}, database };

export const listMessages = query(
  { input: object({}), output: array(Message) },
  async ({ db }: QueryContext<typeof requirements>) =>
    await db.messages.withIndex("by_creation").order("desc").take(100),
);
export const receiveMessage = mutation(
  { input: object({ subject: string(), clientId: string().optional() }), output: Message },
  async ({ db }: MutationContext<typeof requirements>, message) =>
    await db.messages.insert({ subject: message.subject }),
);
export default defineApp(requirements, {
  queries: { listMessages },
  mutations: { receiveMessage },
});
