import { randomBytes } from "node:crypto";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { holdOrganizationEntry } from "../support/organization-entry.ts";
import { scenarios } from "../test-plan.ts";
import { expect, layer } from "@effect/vitest";
import { Clock, Console, Effect, Result, Schedule, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { Evidence, Telemetry, type DeliveredSpan } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource, Inventory } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

const files = [
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, defineProvider, secrets, object, string, router } from "apps";
const service=defineProvider({name:"Evidence service",auth:{key:secrets({label:"API key",fields:object({token:string()})})}});
export default defineApp({user: { accounts:{service:service.many()} }},async()=>({tools: router({
  echo:mutation({description:"Return input",input:object({message:string()})},async(_,input)=>({message:input.message})),
})}));
`,
  },
  appsManifest,
];
/**
 * SQL statements one save of a new account runs, as its two requests' traces record them. Creating
 * the connection runs 10: the caller's access to the app, the app's row, version and provider, the
 * connection and its access row. Submitting the key runs 36: the caller's access to the connection
 * and the app, the account and its access row, the app link, and the account's webhook source on
 * the app, read by its key and then created. These are ceilings: a change that adds a statement to
 * every save fails them. Listing the app's webhook sources to find the account's ran 38.
 */
const connectStatements = 10;
const submitStatements = 36;
/**
 * The first saves, made one at a time and read before the others start, so each finds exactly as
 * many accounts already linked as saves before it. Their spans are complete only while the server
 * exports at its own pace: the four writers send spans faster than the server's single Motel
 * stores them, and the exporter the self-host server has always shipped drops what it holds, and
 * every span for 60 seconds, once an export fails after its retries. A trace read during or just
 * after the other saves may never arrive. That a later save does the same work is checked in
 * webhook-source-lookup.spec.ts, by the query plans of a save beside 100,000 accounts.
 */
const sampledSaves = 8;
/**
 * A loose bound on the saves, for the same statements run much more slowly, such as a lost index.
 * The statements are checked by the traces, not by this. In CI the 300 saves took 15.8 s on the
 * merged head; on the desktop runner, at load 12 to 20, 20 runs took 15 to 37 s (median 18 s).
 * 60 s is about 3.8 times the CI time and 1.6 times the slowest desktop run.
 */
const saveBoundMs = 60_000;
/** The SQL statements of one request's trace, in the order they ran. */
const statementsOf = (spans: ReadonlyArray<DeliveredSpan>) =>
  spans
    .filter((span) => span.operationName === "sql.execute")
    .toSorted((a, b) => a.startTime.localeCompare(b.startTime))
    .map((span) => span.tags["db.query.text"] ?? "");
const traceparent = (traceId: string) => `00-${traceId}-${randomBytes(8).toString("hex")}-01`;
layer(HostedLive, { excludeTestServices: true })("Self-host", (it) => {
  it.effect(scenarios.password.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        for (const role of ["owner", "member"] as const) {
          yield* browser.use("Clear the previous browser session", (page) =>
            page.context().clearCookies(),
          );
          yield* browser.use("Open password sign-in", (page) => page.goto("/login"));
          yield* browser.use("Enter synthetic email", (page) =>
            page.getByLabel("Email", { exact: true }).fill(`${role}@example.test`),
          );
          yield* browser.use("Enter synthetic password", (page) =>
            page.getByLabel("Password", { exact: true }).fill(password),
          );
          const list = yield* holdOrganizationEntry;
          yield* browser.use("Sign in", (page) =>
            page.getByRole("button", { name: "Sign in", exact: true }).click(),
          );
          yield* list.requested;
          expect(
            yield* browser.use(
              "Resolve the password sign-in destination before navigating",
              (page) => Promise.resolve(new URL(page.url()).pathname),
            ),
          ).toBe("/login");
          expect(
            yield* browser.use("Password sign-in shows the shared dashboard skeleton", (page) =>
              page.locator(".shell").count(),
            ),
          ).toBe(1);
          yield* browser.use("Password sign-in loads apps in place", (page) =>
            page
              .getByRole("status", { name: "Loading apps", exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* list.release;
          yield* browser.use("Return to the organization", (page) =>
            page.waitForURL(`**/org/${actors.organization.slug}/apps`),
          );
          yield* browser.use(`${role} has the correct Add permission`, (page) =>
            page
              .getByRole("button", { name: "Add app", exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint(`${role} signed in through self-host password login`);
        }
      }),
    ),
  );
  it.effect(
    scenarios.scale.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const actors = yield* Actors,
            api = yield* Api,
            browser = yield* Browser,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry,
            target = yield* Target;
          const count = target.rows,
            prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: "Scale checks",
            files,
          });
          expect(deployed.status).toBe(200);
          const app = yield* body(App, deployed);
          const access = yield* body(
            Schema.Struct({ revision: Schema.String }),
            yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
              revision: access.revision,
              audience: { kind: "everyone" },
            })).status,
          ).toBe(200);
          yield* browser.login(actors.owner);
          yield* browser.use("Open account inventory", (page) =>
            page.goto(`/org/${actors.organization.slug}/accounts`),
          );
          // Each save's two requests get their own traces, so the work a save did can be read back.
          const save = (row: number) =>
            Effect.gen(function* () {
              const actor = row % 2 === 0 ? actors.owner : actors.admin,
                connect = randomBytes(16).toString("hex"),
                submit = randomBytes(16).toString("hex");
              const connection = yield* api.request(
                actor,
                "POST",
                connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
                {},
                { traceparent: traceparent(connect) },
              );
              expect(connection.status).toBe(200);
              const { id } = yield* body(Resource, connection);
              const saved = yield* api.request(
                actor,
                "POST",
                `${prefix}/connections/${id}/submit`,
                {
                  method: "key",
                  label: `Scale account ${row}`,
                  fields: { token: `synthetic-${row}` },
                },
                { traceparent: traceparent(submit) },
              );
              expect(saved.status).toBe(200);
              return { row, id: (yield* body(Resource, saved)).id, connect, submit };
            });
          let saveMs = 0;
          const saveRows = (rows: ReadonlyArray<number>, concurrency: number) =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis;
              const saves = yield* Effect.forEach(rows, save, { concurrency });
              saveMs += (yield* Clock.currentTimeMillis) - started;
              return saves;
            });
          // The request's own span ends after every statement it ran, so once it is in, they are.
          const statements = (traceId: string) =>
            telemetry
              .settled(traceId, (spans) =>
                spans.some((span) => span.operationName.startsWith("http.server")),
              )
              .pipe(Effect.map(statementsOf));
          const workOf = (saves: ReadonlyArray<Effect.Success<ReturnType<typeof save>>>) =>
            Effect.forEach(
              saves,
              ({ row, connect, submit }) =>
                Effect.all({
                  row: Effect.succeed(row),
                  connect: statements(connect),
                  submit: statements(submit),
                }),
              { concurrency: 4 },
            );
          const rows = (from: number, to: number) =>
            Array.from({ length: to - from }, (_, index) => from + index);
          const sampled = Math.min(sampledSaves, count);
          const { ids, first } = yield* evidence.step(
            `Save ${count} accounts with four concurrent writers`,
            Effect.gen(function* () {
              const early = yield* saveRows(rows(0, sampled), 1);
              const first = yield* workOf(early);
              const rest = yield* saveRows(rows(sampled, count), 4);
              return { ids: [...early, ...rest].map((saved) => saved.id), first };
            }),
          );
          yield* evidence.step(
            "A save's work does not depend on how many accounts the app has",
            Effect.gen(function* () {
              yield* evidence.json("inventory-scale.json", {
                count,
                saveMs,
                first: first.map(({ row, connect, submit }) => ({
                  row,
                  connect: connect.length,
                  submit: submit.length,
                })),
              });
              yield* Console.log(JSON.stringify({ count, saveMs }));
              for (const save of first) {
                expect(save.connect.length, `row ${save.row} connect`).toBeLessThanOrEqual(
                  connectStatements,
                );
                expect(save.submit.length, `row ${save.row} submit`).toBeLessThanOrEqual(
                  submitStatements,
                );
              }
              // Save n finds n accounts already linked to the app, and each runs the same statements
              // with the same text: one that lists the app's accounts by their IDs, or runs once per
              // account, differs between them.
              for (const save of first.slice(1))
                expect(
                  { connect: save.connect, submit: save.submit },
                  `row ${save.row} runs the statements row ${first[0]!.row} ran`,
                ).toEqual({ connect: first[0]!.connect, submit: first[0]!.submit });
              expect(saveMs, "save time backstop").toBeLessThan(saveBoundMs);
            }),
          );
          yield* evidence.step(
            "Every record and selection survives an independent read",
            Effect.gen(function* () {
              expect(new Set(ids).size).toBe(count);
              // Every saved account belongs to the writer who connected it, so each writer's
              // inventory lists exactly their own accounts.
              const inventoryOf = (actor: typeof actors.owner, writer: number) =>
                Effect.gen(function* () {
                  const start = yield* Clock.currentTimeMillis;
                  const response = yield* api.request(actor, "GET", `${prefix}/inventory`);
                  expect(response.status).toBe(200);
                  const inventory = yield* body(Inventory, response),
                    saved = inventory.accounts.filter((account) =>
                      account.label.startsWith("Scale account "),
                    );
                  expect(
                    (yield* Clock.currentTimeMillis) - start,
                    "inventory read budget",
                  ).toBeLessThan(5000);
                  const rows = Array.from({ length: count }, (_, row) => row).filter(
                    (row) => row % 2 === writer,
                  );
                  expect(saved.map((account) => account.id).sort()).toEqual(
                    ids.filter((_, row) => row % 2 === writer).sort(),
                  );
                  expect(saved.map((account) => account.label).sort()).toEqual(
                    rows.map((row) => `Scale account ${row}`).sort(),
                  );
                });
              yield* inventoryOf(actors.owner, 0);
              yield* inventoryOf(actors.admin, 1);
              // Connecting from the app links each account to the app for the writer only.
              const [owner, admin] = yield* Effect.all(
                [actors.owner, actors.admin].map((actor) =>
                  linkedAccountIds(actor, `${prefix}/apps/${app.id}`),
                ),
                { concurrency: 2 },
              );
              expect([...(owner ?? [])].sort()).toEqual(
                ids.filter((_, row) => row % 2 === 0).sort(),
              );
              expect([...(admin ?? [])].sort()).toEqual(
                ids.filter((_, row) => row % 2 === 1).sort(),
              );
            }),
          );
          yield* browser.use("Reload the inventory", (page) => page.reload());
          yield* browser.use("The saved accounts are visible", (page) =>
            page.getByText("Scale account 0", { exact: true }).waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint("Account inventory ready for manual use");
        }),
      ),
    // The saves' 60-second backstop, with room for the reads and the browser after it. The
    // inventory read keeps its own 5-second budget.
    120_000,
  );
  it.effect(scenarios.telemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const response = yield* api.request(
          actors.owner,
          "GET",
          `/api/organizations/${actors.organization.id}/inventory`,
        );
        expect(response.status).toBe(200);
        const request = (yield* evidence.requests).at(-1);
        if (!request) return yield* Effect.die(new Error("Request evidence missing"));
        const delivered = telemetry.query(request.traceId).pipe(
          Effect.flatMap((value) =>
            value.data.some(
              (entry) =>
                entry.traceId === request.traceId &&
                entry.span.serviceName === "executor-selfhost" &&
                // The path records the route's template; the organization is recorded by ID.
                entry.span.tags["url.path"] === "/api/organizations/:organization/inventory" &&
                entry.span.tags["executor.organization.id"] === actors.organization.id &&
                entry.span.tags["http.request.method"] === "GET" &&
                entry.span.tags["http.response.status_code"] === "200",
            )
              ? Effect.succeed(value)
              : Effect.fail(new Error("The actual HTTP server span must reach Motel")),
          ),
        );
        const result = yield* delivered.pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
          Effect.timeout("20 seconds"),
          Effect.result,
        );
        expect(
          Result.isSuccess(result),
          "The actual HTTP server span must reach Motel within 20 seconds",
        ).toBe(true);
        if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
        const queries = result.success.data.filter(
          (entry) => entry.span.operationName === "sql.execute",
        );
        expect(queries.length).toBeGreaterThan(0);
      }),
    ),
  );
});
