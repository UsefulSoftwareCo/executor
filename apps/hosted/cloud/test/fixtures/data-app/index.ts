import { query, mutation, defineApp, defineDatabase, json, object, string, table } from "apps";
const database = defineDatabase({ messages: table({ body: string() }).index("by_body", ["body"]) });
let reads = 0;
export default defineApp({ accounts: {}, database }, async () => ({
  queries: {
    external: query({ input: object({}), output: string() }, async ({ fetch }) =>
      (await fetch("https://fixture.example/read")).text(),
    ),
    list: query({ input: object({}), output: json() }, async ({ db }) => ({
      reads: ++reads,
      rows: await db.messages.withIndex("by_body").collect(),
    })),
  },
  mutations: {
    ask: mutation({ input: object({}) }, async ({ elicit }) =>
      elicit({
        mode: "form",
        message: "Confirm fixture",
        requestedSchema: { type: "object", properties: {} },
      }),
    ),
    add: mutation(
      { input: object({ body: string() }), output: json() },
      async ({ db }, value) => await db.messages.insert(value),
    ),
  },
}));
