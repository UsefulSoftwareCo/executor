import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { appsManifest } from "../support/apps-release.ts";

const Event = Schema.Struct({
  event: Schema.String,
  distinct_id: Schema.optional(Schema.String),
  properties: Schema.Record(Schema.String, Schema.Json),
});
const PostHogBatch = Schema.Struct({ batch: Schema.Array(Event) });
const RelayEvent = Schema.Struct({
  event: Schema.String,
  account_id: Schema.String,
  timestamp: Schema.String,
  properties: Schema.Record(Schema.String, Schema.String),
});
const RelayRecord = Schema.Struct({
  kind: Schema.Literals(["analytics", "feedback"]),
  body: Schema.Json,
});
const RelayBatch = Schema.Struct({ events: Schema.Array(RelayEvent) });

const posthogEvents = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Schema.decodeUnknownSync(Schema.fromJsonString(PostHogBatch))(line).batch);

const relayRecords = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(RelayRecord))(line));

layer(HostedLive, { excludeTestServices: true })("Telemetry relay", (it) =>
  it.effect(scenarios.telemetryRelay.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          api = yield* Api,
          fs = yield* FileSystem.FileSystem,
          target = yield* Target;
        const relayEnabled = process.env.E2E_TELEMETRY_RELAY === "1";
        const session = yield* body(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
          yield* api.request(actors.owner, "GET", "/api/auth/get-session"),
        );
        const beforeRelay = relayEnabled
          ? relayRecords(yield* fs.readFileString(`${target.directory}/telemetry-relay.ndjson`))
          : [];
        const beforePostHog = relayEnabled
          ? []
          : posthogEvents(yield* fs.readFileString(`${target.directory}/analytics.ndjson`));
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Telemetry relay fixture",
          files: [
            {
              path: "index.ts",
              content: `
import { defineApp, mutation, object, query, router, string } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ message: string() }) }, async (_, input) => ({ message: input.message })),
  guarded: mutation({ input: object({}), approval: () => "user-approval" }, async () => "approved"),
}) }));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const tools = `${prefix}/apps/${encodeURIComponent(app.id)}/tools`;

        const call = yield* api.request(actors.owner, "POST", `${tools}/call`, {
          tool: "echo",
          kind: "query",
          input: { message: "PRIVATE_TOOL_INPUT" },
        });
        expect(call.status, JSON.stringify(call.body)).toBe(200);

        const pending = yield* body(
          Schema.Struct({ status: Schema.Literal("approval-required"), requestId: Schema.String }),
          yield* api.request(actors.owner, "POST", `${tools}/run`, {
            tool: "guarded",
            kind: "mutation",
            input: {},
          }),
        );
        const resumed = yield* api.request(
          actors.owner,
          "POST",
          `${tools}/approvals/${encodeURIComponent(pending.requestId)}`,
          { response: { action: "accept", content: {} } },
        );
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

        const forgedAppId = "app_person@example.invalid";
        const forgedCall = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${encodeURIComponent(forgedAppId)}/tools/call`,
          { tool: "echo", kind: "query", input: { message: "PRIVATE_QUERY" } },
        );
        expect(forgedCall.status).not.toBe(200);

        const optedOutCall = yield* api.request(
          actors.owner,
          "POST",
          `${tools}/call`,
          { tool: "echo", kind: "query", input: { message: "PRIVATE_DNT_INPUT" } },
          { dnt: "1" },
        );
        expect(optedOutCall.status, JSON.stringify(optedOutCall.body)).toBe(200);

        const feedback = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/feedback`,
          { message: "Synthetic relay feedback", account_id: "person@example.invalid" },
          { dnt: "1" },
        );
        if (feedback.status !== 200) {
          expect(feedback.status).toBe(400);
          expect(
            (yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/feedback`,
              { message: "Synthetic relay feedback" },
              { dnt: "1" },
            )).status,
          ).toBe(200);
        }

        if (relayEnabled) {
          const records = yield* Effect.gen(function* () {
            const read = () =>
              fs
                .readFileString(`${target.directory}/telemetry-relay.ndjson`)
                .pipe(Effect.map(relayRecords));
            return yield* read().pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (records) => records.some((record) => record.kind === "feedback"),
              }),
              Effect.timeout("10 seconds"),
            );
          });
          const fresh = records.slice(beforeRelay.length);
          const batches = fresh
            .filter((record) => record.kind === "analytics")
            .map((record) => Schema.decodeUnknownSync(RelayBatch)(record.body));
          const events = batches.flatMap((batch) => batch.events);
          expect(events.filter((event) => event.event === "tool_execution_completed")).toHaveLength(
            2,
          );
          for (const event of events.filter((item) => item.event === "tool_execution_completed")) {
            expect(event.account_id).toBe(session.user.id);
            expect(event.properties).toMatchObject({ app_id: app.id });
            expect(Object.keys(event.properties)).toEqual(["app_id"]);
          }
          const feedbackRecords = fresh.filter((record) => record.kind === "feedback");
          expect(feedbackRecords.length).toBeGreaterThanOrEqual(1);
          for (const record of feedbackRecords) {
            expect(record.body).toMatchObject({
              account_id: session.user.id,
              message: "Synthetic relay feedback",
            });
          }
          const wire = JSON.stringify(fresh);
          for (const privateValue of [
            "person@example.invalid",
            forgedAppId,
            "PRIVATE_TOOL_INPUT",
            "PRIVATE_QUERY",
            "PRIVATE_DNT_INPUT",
          ])
            expect(wire).not.toContain(privateValue);
        } else {
          const events = yield* Effect.gen(function* () {
            const read = () =>
              fs
                .readFileString(`${target.directory}/analytics.ndjson`)
                .pipe(Effect.map(posthogEvents));
            return yield* read().pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (events) =>
                  events.length > beforePostHog.length &&
                  events.some((event) => event.event === "feedback_submitted"),
              }),
              Effect.timeout("10 seconds"),
            );
          });
          expect(events.length).toBeGreaterThan(beforePostHog.length);
          expect(events.some((event) => event.event === "feedback_submitted")).toBe(true);
        }
      }),
    ),
  ),
);
