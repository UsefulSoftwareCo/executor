/** Closing an optimistic app must distinguish pending writes from read reconciliation. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";

const files = [
  {
    path: "schema.ts",
    content: `import { object, string } from "apps";
export const Todo = object({ id: string(), title: string() });`,
  },
  {
    path: "index.ts",
    content: `import { array, boolean, defineApp, defineDatabase, mutation, object, query, string, table } from "apps";
import { Todo } from "./schema.ts";
const database = defineDatabase({ todos: table({ title: string() }) });
export const list = query({ input: object({}), output: array(Todo) }, async ({ db }) =>
  await db.todos.withIndex("by_creation").collect());
export const add = mutation({ input: object({ title: string() }), output: Todo }, async ({ db }, input) =>
  await db.todos.insert(input));
export const remove = mutation({ input: object({ id: string() }), output: boolean() }, async ({ db }, { id }) =>
  await db.todos.delete(id));
export default defineApp({ accounts: {}, database }, { queries: { list }, mutations: { add, remove } });`,
  },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Pending deletes</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import { useState } from "react";
import { createRoot } from "react-dom/client";
import { array, boolean } from "apps";
import { createAppClient, mutationReference, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { list, remove } from "../index.ts";
import { Todo } from "../schema.ts";
const client = createAppClient();
const listRef = queryReference<typeof list>("list");
const todos = client.queryAtom(listRef, {}, array(Todo));
const removeTodo = client.mutation(mutationReference<typeof remove>("remove"), boolean())
  .withOptimisticUpdate((store, { id }) => {
    const rows = store.getQuery(listRef, {});
    if (rows !== undefined) store.setQuery(listRef, {}, rows.filter(row => row.id !== id));
  });
function Page() {
  const { data, pending } = useAppQuery(todos);
  const [acknowledged, setAcknowledged] = useState(0);
  const [failed, setFailed] = useState(false);
  return <main><h1>Pending deletes</h1><p role="status">{acknowledged} acknowledged</p>
    {failed && <p role="alert">Delete failed</p>}
    {pending ? <p>Loading</p> : <ul>{data?.map(row => <li key={row.id}>
      <button onClick={() => {
        setFailed(false);
        void removeTodo({ id: row.id }).then(
          () => setAcknowledged(value => value + 1), () => setFailed(true));
      }}>Delete {row.title}</button>
    </li>)}</ul>}
  </main>;
}
const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(<Page />);`,
  },
];

layer(HostedLive, { excludeTestServices: true })("Pending app writes", (it) => {
  it.effect(scenarios.appPendingWrites.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Pending deletes ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        for (const title of ["First", "Second", "Third"]) {
          expect(
            (yield* api.request(actors.owner, "POST", `${prefix}/${app.id}/data/mutate`, {
              name: "add",
              input: { title },
            })).status,
          ).toBe(200);
        }
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the persisted todos", (page) => page.goto(url));
        yield* browser.use("Wait for the stored rows", (page) =>
          page.getByRole("button", { name: "Delete Third" }).waitFor(),
        );
        const guarded = (label: string) =>
          browser.use(label, (page) =>
            page.evaluate(() => {
              const event = new Event("beforeunload", { cancelable: true });
              window.dispatchEvent(event);
              return event.defaultPrevented;
            }),
          );
        const attemptClose = (label: string) =>
          browser.use(label, (page) => {
            const dialog = page.waitForEvent("dialog", { timeout: 5000 }).then(
              (dialog) => dialog.dismiss().then(() => dialog.type()),
              () => (page.isClosed() ? "closed without warning" : "no warning"),
            );
            return page.close({ runBeforeUnload: true }).then(() => dialog);
          });
        expect(yield* guarded("Idle subscriptions do not prevent leaving")).toBe(false);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const failed = yield* holdQuery(["/_executor/api/mutate"], "fail", { method: "POST" });
            yield* browser.use("Start a delete that will fail", (page) =>
              page.getByRole("button", { name: "Delete First" }).click(),
            );
            yield* failed.requested;
            expect(yield* guarded("The active delete protects the page")).toBe(true);
            const resumed = yield* browser.use("Watch recovery after the failed write", (page) => {
              const request = page.waitForRequest(
                (request) => new URL(request.url()).pathname === "/_executor/api/subscribe",
              );
              return Promise.resolve({ request });
            });
            yield* failed.release;
            yield* browser.use("The rejected delete reports its failure", (page) =>
              page.getByRole("alert").waitFor(),
            );
            yield* browser.use("Rollback restores the row", (page) =>
              page.getByRole("button", { name: "Delete First" }).waitFor(),
            );
            expect(yield* guarded("A rejected write releases the leave guard")).toBe(false);
            yield* browser.use("The rejected write finishes reconciliation", () => resumed.request);
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const write = yield* holdQuery(["/_executor/api/mutate"], "continue", {
              method: "POST",
            });
            const firstRead = yield* holdQuery(["/_executor/api/query"], "continue", {
              method: "POST",
            });
            for (const title of ["First", "Second", "Third"]) {
              yield* browser.use(`Delete ${title} before the server responds`, (page) =>
                page.getByRole("button", { name: `Delete ${title}` }).click(),
              );
            }
            yield* write.requested;
            expect(
              yield* browser.use("All rows disappear optimistically", (page) =>
                page.getByRole("listitem").count(),
              ),
            ).toBe(0);
            expect(yield* attemptClose("Closing the tab warns about unsaved deletes")).toBe(
              "beforeunload",
            );
            yield* write.release;
            yield* firstRead.requested;
            yield* browser.use("Only the first delete is acknowledged", (page) =>
              page.getByRole("status").filter({ hasText: "1 acknowledged" }).waitFor(),
            );
            expect(
              yield* attemptClose("Queued deletes still protect the tab during reconciliation"),
            ).toBe("beforeunload");
            const secondRead = yield* holdQuery(["/_executor/api/query"], "continue", {
              method: "POST",
            });
            yield* firstRead.release;
            yield* secondRead.requested;
            yield* browser.use("The second delete is acknowledged", (page) =>
              page.getByRole("status").filter({ hasText: "2 acknowledged" }).waitFor(),
            );
            const lastRead = yield* holdQuery(["/_executor/api/query"], "continue", {
              method: "POST",
            });
            yield* secondRead.release;
            yield* lastRead.requested;
            yield* browser.use("Every delete is acknowledged", (page) =>
              page.getByRole("status").filter({ hasText: "3 acknowledged" }).waitFor(),
            );
            expect(yield* guarded("Read reconciliation alone does not prevent leaving")).toBe(
              false,
            );
            yield* lastRead.release;
          }),
        );
        yield* browser.use("Close the tab after every write settles", (page) => {
          const closed = page.waitForEvent("close");
          return page.close({ runBeforeUnload: true }).then(() => closed);
        });
        const saved = yield* api.request(actors.owner, "POST", `${prefix}/${app.id}/data/query`, {
          name: "list",
          input: {},
        });
        expect(saved.status).toBe(200);
        expect(yield* body(Schema.Array(Schema.Unknown), saved)).toEqual([]);
      }),
    ),
  );
});
