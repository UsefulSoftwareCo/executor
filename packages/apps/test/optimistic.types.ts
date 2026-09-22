/** Inference checks for authored optimistic callbacks; never executed. */
import { array, number, object, string, mutation, query } from "../src/index.ts";
import { createAppClient, mutationReference, queryReference } from "../src/client.ts";
const list = query({ input: object({ filter: string() }), output: array(number()) }, async () => [
  1,
]);
const add = mutation({ input: object({ amount: number() }) }, async (_, input) => input.amount);
const listRef = queryReference<typeof list>("list");
const client = createAppClient();
client.queryAtom(listRef, { filter: "all" }, array(number()));
const mutate = client.mutation(mutationReference<typeof add>("add"), number());
const optimistic = mutate.withOptimisticUpdate((store, input) => {
  const rows = store.getQuery(listRef, { filter: "all" });
  if (rows !== undefined) store.setQuery(listRef, { filter: "all" }, [...rows, input.amount]);
  // @ts-expect-error Query arguments retain their declared types.
  store.getQuery(listRef, { filter: 1 });
  // @ts-expect-error Query results retain their declared types.
  store.setQuery(listRef, { filter: "all" }, ["wrong"]);
  for (const { input, value } of store.getAllQueries(listRef)) {
    const filter: string = input.filter;
    const rows: readonly number[] | undefined = value;
    void filter;
    void rows;
  }
});
const output: Promise<number> = optimistic({ amount: 1 });
// @ts-expect-error Mutations retain their input types.
optimistic({ amount: "one" });
// @ts-expect-error Projections cannot be asynchronous.
mutate.withOptimisticUpdate(async () => {});
void output;
