/** A handled replay failure still leaves a safe, delivered diagnostic after a write starts. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { holdQuery } from "../support/query-transition.ts";
const Batch = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(Schema.Struct({ traceId: Schema.String, name: Schema.String })),
        }),
      ),
    }),
  ),
});
layer(HostedLive, { excludeTestServices: true })("Optimistic observability", (it) => {
  it.effect(scenarios.optimisticObservability.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name: `Replay ${randomUUID()}`,
            files: [
              {
                path: "package.json",
                content: JSON.stringify({
                  dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
                }),
              },
              {
                path: "index.ts",
                content: `import { defineApp, query, mutation, object, string, number, boolean } from "apps";
export const read = query({ input: object({ key: string() }), output: number() }, async () => 1);
export const write = mutation({ input: object({}), output: boolean() }, async () => true);
export default defineApp({ accounts: {} }, { queries: { read }, mutations: { write } });`,
              },
              {
                path: "ui/index.html",
                content:
                  '<!doctype html><div id="root"></div><script type="module" src="./main.tsx"></script>',
              },
              {
                path: "ui/main.tsx",
                content: `import {useState} from "react"; import {createRoot} from "react-dom/client";
import {number, boolean} from "apps"; import {createAppClient, queryReference, mutationReference} from "apps/client"; import {useAppQuery} from "apps/react";
import type {read, write} from "../index.ts";
const client=createAppClient(); const ref=queryReference<typeof read>("read");
const first=client.queryAtom(ref,{key:"first"},number()); const extra=client.queryAtom(ref,{key:"extra"},number()); let calls=0;
const change=client.mutation(mutationReference<typeof write>("write"),boolean()).withOptimisticUpdate(() => { if (++calls > 1) throw new Error("private-replay-value"); });
function Extra(){useAppQuery(extra);return <p>Additional query</p>;}
function Page(){const {pending}=useAppQuery(first);const [show,setShow]=useState(false),[done,setDone]=useState(false);return <main><p role="status">{pending?"Loading":done?"Saved":"Ready"}</p><button onClick={()=>{void change({}).then(()=>setDone(true));}}>Begin</button><button onClick={()=>setShow(true)}>Mount query</button>{show&&<Extra/>}</main>;}
createRoot(document.getElementById("root")).render(<Page/>);`,
              },
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/${app.id}/ui`);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the replay fixture", (page) => page.goto(url));
        yield* browser.use("Wait for the first query", (page) =>
          page.getByRole("status").filter({ hasText: "Ready" }).waitFor(),
        );
        const hold = yield* holdQuery(["/_executor/api/mutate"], "continue", { method: "POST" });
        yield* browser.use("Start the real mutation", (page) =>
          page.getByRole("button", { name: "Begin", exact: true }).click(),
        );
        yield* hold.requested;
        const batch = yield* browser.use("Mount a query while the write is in flight", (page) =>
          Promise.all([
            page
              .waitForRequest(
                (request) =>
                  request.url().endsWith("/_executor/api/telemetry/traces") &&
                  request.postData()?.includes('"ui.optimistic.failure"') === true,
              )
              .then((request) => request.postDataJSON()),
            page.getByRole("button", { name: "Mount query", exact: true }).click(),
          ]).then(([batch]) => batch),
        );
        const decoded = yield* Schema.decodeUnknownEffect(Batch)(batch);
        const id = decoded.resourceSpans
          .flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
          .find((span) => span.name === "ui.optimistic.failure")?.traceId;
        if (id === undefined) return yield* Effect.die("Replay failure trace missing");
        const trace = yield* telemetry.query(id).pipe(
          Effect.flatMap((trace) =>
            trace.data.some(({ span }) => span.operationName === "ui.optimistic.failure")
              ? Effect.succeed(trace)
              : Effect.fail(new Error("Replay failure not delivered")),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
        );
        expect(
          trace.data.find(({ span }) => span.operationName === "ui.optimistic.failure")?.span,
        ).toMatchObject({
          status: "error",
          tags: { "executor.optimistic.sent": "true", "executor.operation.id": expect.any(String) },
        });
        expect(JSON.stringify(trace)).not.toContain("private-replay-value");
        yield* hold.release;
        yield* browser.use("The original write still completes", (page) =>
          page.getByRole("status").filter({ hasText: "Saved" }).waitFor(),
        );
        yield* evidence.json("replay-failure.json", trace);
      }),
    ),
  );
});
