/** Real local HTTP contracts discover schedules without invoking mutations. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body } from "../support/api.ts";
import { Target } from "../support/platform.ts";
import { TestLive, withCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const settings = Schema.Struct({
  enabled: Schema.Boolean,
  approvalMode: Schema.String,
  nextAt: Schema.NullOr(Schema.String),
});
const definitions = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    tool: Schema.String,
    input: Schema.Unknown,
    settings: Schema.NullOr(settings),
  }),
);
const source = `import { defineApp, mutation, interval, cron, object, string } from "apps";
const send = mutation({ input: object({ channel: string() }) }, async () => { throw new Error("Discovery must not execute"); });
export default defineApp({ accounts: {} }, async () => ({  mutations: { send }, schedules: {
  digest: interval({ minutes: 5 }, send, { channel: "support" }),
  morning: cron({ expression: "0 9 * * MON-FRI", timezone: "America/Los_Angeles" }, send, { channel: "daily" }),
} }));`;
layer(TestLive, { excludeTestServices: true })("Local schedules", (it) => {
  it.effect(scenarios.schedules.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: "Schedule fixture",
            files: [{ path: "index.ts", content: source }],
          },
          headers,
        );
        expect(deployed.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          deployed,
        );
        const path = `/v1/apps/${app.id}/schedules`;
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const read = yield* session.send("GET", `${path}/definitions`, undefined, headers);
        expect(read.status).toBe(200);
        const schedules = yield* body(definitions, read);
        expect(schedules.map((schedule) => [schedule.name, schedule.tool])).toEqual([
          ["digest", "mutations.send"],
          ["morning", "mutations.send"],
        ]);
        expect(schedules.every((schedule) => schedule.settings === null)).toBe(true);
        expect(schedules[0]?.input).toEqual({ channel: "support" });
        const paused = yield* session.send(
          "PATCH",
          `${path}/digest`,
          { actor: "local", enabled: false },
          headers,
        );
        expect(paused.status).toBe(200);
        expect(yield* body(settings, paused)).toMatchObject({
          enabled: false,
          nextAt: null,
          approvalMode: "automatic",
        });
        const enabled = yield* session.send(
          "PATCH",
          `${path}/digest`,
          { actor: "local", enabled: true, approvalMode: "browser" },
          headers,
        );
        expect(enabled.status).toBe(200);
        expect((yield* body(settings, enabled)).enabled).toBe(true);
        expect(
          (yield* session.send("GET", `${path}?owner=another-owner`, undefined, headers)).status,
        ).toBe(404);
        expect(
          (yield* session.send(
            "PATCH",
            `${path}/missing`,
            { actor: "local", enabled: true, approvalMode: "automatic" },
            headers,
          )).status,
        ).toBe(404);
        expect((yield* session.send("GET", "/v1/scheduled-runs", undefined, headers)).body).toEqual(
          [],
        );
      }),
    ),
  );
});
