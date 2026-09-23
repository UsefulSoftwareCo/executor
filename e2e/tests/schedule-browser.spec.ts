/** Real dashboard controls and browser approval, backed by the complete local server. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

class Pending extends Schema.TaggedError<Pending>()("Pending", {}) {}
const source = `import { defineApp, mutation, object, interval } from "apps";
import { always } from "apps/operations/approval";
const send = mutation({ input: object({}), approval: always() }, async () => ({ done: true }));
export default defineApp({ accounts: {} }, async () => ({  mutations: { send }, schedules: { digest: interval({ hours: 1 }, send, {}) } }));`;
layer(TestLive, { excludeTestServices: true })("Schedule dashboard", (it) => {
  it.effect(scenarios.scheduledBrowser.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          browser = yield* Browser,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Browser schedules",
            files: [{ path: "index.ts", content: source }],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the dashboard", (page) => page.goto(url));
        yield* browser.use("Wait for authentication", (page) =>
          page.getByRole("link", { name: "Approvals", exact: true }).waitFor(),
        );
        yield* browser.use("Open schedule controls", (page) =>
          page.goto(`${target.metadata.origin}/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("Choose approval mode", (page) =>
          page.getByRole("combobox", { name: "Approvals for digest" }).click(),
        );
        yield* browser.use("Use browser approvals", (page) =>
          page.getByRole("option", { name: "Browser approvals" }).click(),
        );
        yield* browser.use("Enable the schedule", (page) =>
          page.getByRole("button", { name: "Enable", exact: true }).click(),
        );
        yield* browser.use("Wait for enabled controls", (page) =>
          page.getByRole("button", { name: "Pause", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("01 Schedule controls");
        yield* browser.use("Request a run", (page) =>
          page.getByRole("button", { name: "Run now", exact: true }).click(),
        );
        yield* browser.use("Open approvals", (page) =>
          page.getByRole("link", { name: "Approvals", exact: true }).click(),
        );
        yield* browser.use("Reload the approval queue", (page) => page.reload());
        yield* browser.use("Wait for pending approval", (page) =>
          page.getByRole("link", { name: "Review", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("02 Approvals list");
        yield* browser.use("Review the pending run", (page) =>
          page.getByRole("link", { name: "Review", exact: true }).click(),
        );
        yield* browser.use("Reload the bookmarked approval", (page) => page.reload());
        yield* browser.use("Wait for approval form", (page) =>
          page.getByRole("button", { name: "Approve", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("03 Review scheduled run");
        yield* browser.use("Approve the mutation", (page) =>
          page.getByRole("button", { name: "Approve", exact: true }).click(),
        );
        yield* browser.use("Observe acknowledgement", (page) =>
          page
            .getByText("Your response was saved. Approved runs continue in the background.", {
              exact: true,
            })
            .waitFor(),
        );
        yield* browser.checkpoint("04 Approval saved");
        yield* session.send("GET", `/v1/scheduled-runs?app=${app.id}`, undefined, headers).pipe(
          Effect.flatMap((response) =>
            body(Schema.Array(Schema.Struct({ status: Schema.String })), response),
          ),
          Effect.flatMap((runs) =>
            runs.some((run) => run.status === "succeeded")
              ? Effect.void
              : Effect.fail(new Pending()),
          ),
          Effect.retry({
            while: (error) => error instanceof Pending,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout("15 seconds"),
        );
        yield* browser.use("Reopen schedule controls", (page) =>
          page.goto(`${target.metadata.origin}/apps/${app.id}?view=schedules`),
        );
        yield* browser.use("Pause the schedule", (page) =>
          page.getByRole("button", { name: "Pause", exact: true }).click(),
        );
        yield* browser.use("Observe paused state", (page) =>
          page.getByRole("button", { name: "Enable", exact: true }).waitFor(),
        );
        const saved = yield* session.send(
          "GET",
          `/v1/apps/${app.id}/schedules`,
          undefined,
          headers,
        );
        expect(
          yield* body(Schema.Array(Schema.Struct({ enabled: Schema.Boolean })), saved),
        ).toEqual([{ enabled: false }]);
      }),
    ),
  );
});
