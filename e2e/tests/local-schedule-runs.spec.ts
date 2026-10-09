/** Real timers, mutations and cookie-authenticated approval delivery through the complete local product. */
import { expect, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Redacted, Ref, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Evidence } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";

const Run = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
const Runs = Schema.Array(Run);
class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}
const migration = {
  path: "migrations/0001_events.sql",
  content: "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);\n",
};
const source = `import { defineApp, string, object, query, mutation, interval, type MutationContext, type QueryContext, router } from "apps";
import { always } from "apps/operations/approval";
const requirements = { accounts: {} };
const record = mutation({ input: object({ message: string() }), approval: always() }, async (ctx: MutationContext<typeof requirements>, input) =>
  ctx.sql.exec("INSERT INTO events (message) VALUES (?) RETURNING seq, message", input.message).one());
const blocked = mutation({ input: object({}), approval: () => "denied" }, async () => { throw new Error("Denied body ran"); });
const input = mutation({ input: object({}) }, async ({ elicit }) => await elicit({ mode: "form", message: "Input unavailable", requestedSchema: { type: "object", properties: {} } }));
const slow = mutation({ input: object({}) }, async ({ signal }) => {
  await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 2300); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  return { finished: true };
});
export default defineApp(requirements, async () => ({
   tools: router({
     events: query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ctx.sql.exec("SELECT seq, message FROM events ORDER BY seq LIMIT 100").toArray()),
     record, blocked, input, slow,
   }), schedules: {
    automatic: interval({ minutes: 1 }, record, { message: "automatic" }),
    review: interval({ minutes: 1 }, record, { message: "review" }),
    blocked: interval({ minutes: 1 }, blocked, {}),
    input: interval({ minutes: 1 }, input, {}),
    slow: interval({ minutes: 1 }, slow, {}),
  },
}));`;
layer(TestLive, { excludeTestServices: true })("Scheduled runs", (it) => {
  it.effect(scenarios.scheduledRuns.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Scheduled ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, migration, appsManifest],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({
            app: Schema.Struct({ id: Schema.String, activeDeployment: Schema.String }),
          }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const configure = (
          name: string,
          enabled: boolean,
          approvalMode: "automatic" | "browser" = "automatic",
        ) =>
          Effect.gen(function* () {
            const response = yield* session.send(
              "PATCH",
              `/v1/apps/${app.id}/schedules/${name}`,
              { actor: "local", enabled, approvalMode },
              headers,
            );
            expect(response.status).toBe(200);
          });
        const runs = session
          .send("GET", `/v1/scheduled-runs?app=${app.id}`, undefined, headers)
          .pipe(Effect.flatMap((response) => body(Runs, response)));
        const waitFor = (name: string, status: string, within: Duration.Input = "15 seconds") =>
          evidence.step(
            `Wait for ${name} schedule to become ${status}`,
            Effect.gen(function* () {
              const observed = yield* Ref.make<typeof Runs.Type>([]);
              return yield* runs.pipe(
                Effect.tap((rows) => Ref.set(observed, rows)),
                Effect.flatMap((rows) => {
                  const found = rows.find((row) => row.name === name && row.status === status);
                  return found === undefined ? Effect.fail(new Pending()) : Effect.succeed(found);
                }),
                Effect.retry({
                  while: (error) => error instanceof Pending,
                  schedule: Schedule.spaced("100 millis"),
                }),
                Effect.timeout(within),
                Effect.tapError(() =>
                  Ref.get(observed).pipe(
                    Effect.flatMap((rows) =>
                      evidence.json(`schedule-${name}-${status}.json`, {
                        expected: { name, status },
                        observed: rows,
                      }),
                    ),
                  ),
                ),
              );
            }),
          );
        // Intervals are floored at one minute, so each check asks for its run now.
        const runNow = (name: string) =>
          session.send("POST", `/v1/apps/${app.id}/schedules/${name}/run`, {}, headers);
        const dispatch = (name: string) =>
          Effect.gen(function* () {
            expect((yield* runNow(name)).status).toBe(200);
          });
        yield* configure("automatic", true);
        yield* dispatch("automatic");
        yield* waitFor("automatic", "succeeded");
        yield* configure("automatic", false);
        yield* configure("blocked", true);
        yield* dispatch("blocked");
        expect((yield* waitFor("blocked", "failed")).failure).toBe("ToolBlocked");
        yield* configure("blocked", false);
        yield* configure("input", true);
        yield* dispatch("input");
        expect((yield* waitFor("input", "failed")).failure).toBe("ToolElicitationFailed");
        yield* configure("input", false);
        yield* configure("slow", true);
        yield* dispatch("slow");
        // Only one run is active per schedule; a second request is refused while the first runs.
        yield* waitFor("slow", "running");
        expect((yield* runNow("slow")).status).toBe(409);
        yield* waitFor("slow", "succeeded");
        yield* configure("slow", false);
        const slowRuns = (yield* runs).filter((run) => run.name === "slow");
        expect(slowRuns).toHaveLength(1);
        expect(slowRuns[0]?.finishedAt).not.toBeNull();

        yield* configure("review", true, "browser");
        yield* dispatch("review");
        const pending = yield* waitFor("review", "awaiting-approval");
        yield* configure("review", false, "browser");
        const endpoint = `/dashboard/api/scheduled-runs/${pending.id}/approval`;
        const rawEndpoint = `/v1/scheduled-runs/${pending.id}/approval`;
        expect((yield* session.send("GET", rawEndpoint, undefined, headers)).status).toBe(403);
        expect(
          (yield* session.send("POST", rawEndpoint, { action: "accept" }, headers)).status,
        ).toBe(403);
        expect((yield* session.send("GET", endpoint, undefined, headers)).status).toBe(403);
        const paired = yield* api.session();
        const pairing = yield* paired.send("POST", "/auth/pair", undefined, headers);
        const link = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        expect(
          (yield* api.request(paired, "POST", "/auth/exchange", {
            token: new URL(link.url).hash.slice("#pair=".length),
          })).status,
        ).toBe(200);
        const review = yield* api.request(paired, "GET", endpoint);
        expect(review.status).toBe(200);
        const request = yield* body(
          Schema.Struct({
            status: Schema.Literal("pending"),
            request: Schema.Struct({
              expiresAt: Schema.Number,
              invocation: Schema.Struct({ input: Schema.Unknown }),
            }),
          }),
          review,
        );
        expect(request.request.invocation.input).toEqual({ message: "review" });
        expect(request.request.expiresAt - (yield* Clock.currentTimeMillis)).toBeGreaterThan(
          14 * 60_000,
        );
        const accepted = yield* api.request(paired, "POST", endpoint, {
          response: { action: "accept", content: {} },
        });
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ status: "answered" });
        yield* waitFor("review", "succeeded");
        expect(
          (yield* api.request(paired, "POST", endpoint, {
            response: { action: "accept", content: {} },
          })).body,
        ).toEqual({ status: "unavailable" });
        const data = yield* session.send(
          "POST",
          "/v1/app-data/query",
          { app: app.id, name: "events", input: {} },
          headers,
        );
        expect(data.status).toBe(200);
        const events = yield* body(Schema.Array(Schema.Struct({ message: Schema.String })), data);
        expect(events.filter((event) => event.message === "review")).toHaveLength(1);
        expect(events.some((event) => event.message === "automatic")).toBe(true);

        // App source defines schedules: an activation deletes settings it no longer declares.
        yield* configure("automatic", true);
        yield* configure("review", true, "browser");
        yield* dispatch("review");
        const withdrawn = yield* waitFor("review", "awaiting-approval");
        const saved = session.send("GET", `/v1/apps/${app.id}/schedules`, undefined, headers).pipe(
          Effect.flatMap((response) =>
            body(Schema.Array(Schema.Struct({ name: Schema.String })), response),
          ),
          Effect.map((rows) => rows.map((row) => row.name).toSorted()),
        );
        const without = (names: readonly string[]) =>
          source
            .split("\n")
            .filter((line) => !names.some((name) => line.startsWith(`    ${name}: interval(`)))
            .join("\n");
        const activate = (deployment: string, expectedDeployment: string) =>
          Effect.gen(function* () {
            const response = yield* session.send(
              "POST",
              `/v1/apps/${app.id}/activate`,
              { deployment, expectedDeployment },
              headers,
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
          });
        const updated = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            app: app.id,
            files: [
              { path: "index.ts", content: without(["automatic", "review", "slow"]) },
              migration,
              appsManifest,
            ],
          },
          headers,
        );
        expect(updated.status).toBe(200);
        const current = yield* body(
          Schema.Struct({ app: Schema.Struct({ activeDeployment: Schema.String }) }),
          updated,
        );
        expect(yield* saved).toEqual(["blocked", "input"]);
        // Run history and the waiting approval go with the removed settings.
        expect(
          (yield* runs).filter((run) => run.name === "automatic" || run.name === "review"),
        ).toEqual([]);
        const withdrawnEndpoint = `/dashboard/api/scheduled-runs/${withdrawn.id}/approval`;
        expect((yield* api.request(paired, "GET", withdrawnEndpoint)).body).toEqual({
          status: "unavailable",
        });
        expect(
          (yield* api.request(paired, "POST", withdrawnEndpoint, {
            response: { action: "accept", content: {} },
          })).body,
        ).toEqual({ status: "unavailable" });

        // A removal that lands during a run lets the mutation finish, then drops its record.
        yield* activate(app.activeDeployment, current.app.activeDeployment);
        expect(yield* saved).toEqual(["blocked", "input"]);
        yield* configure("slow", true);
        yield* dispatch("slow");
        yield* waitFor("slow", "running");
        yield* activate(current.app.activeDeployment, app.activeDeployment);
        expect(yield* saved).toEqual(["blocked", "input"]);
        expect((yield* runs).filter((run) => run.name === "slow").map((run) => run.status)).toEqual(
          ["running"],
        );
        yield* evidence.step(
          "Wait for the removed schedule's run to finish and leave the history",
          runs.pipe(
            Effect.flatMap((rows) =>
              rows.some((run) => run.name === "slow") ? Effect.fail(new Pending()) : Effect.void,
            ),
            Effect.retry({
              while: (error) => error instanceof Pending,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("15 seconds"),
          ),
        );
      }),
    ),
  );
});
