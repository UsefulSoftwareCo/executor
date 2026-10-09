import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import {
  awaitAnalytics,
  deliveredAnalytics,
  localAgent,
  reportedBuild,
  type DeliveredEvent,
} from "../support/instance-analytics.ts";
import { managementApp } from "../support/management-app.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";

const Viewer = Schema.Struct({ userId: Schema.String });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Json,
  toolError: Schema.optionalKey(Schema.Literal(true)),
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const disabled = { _tag: "FeedbackDisabled", message: "Feedback is disabled on this instance." };

/** Properties every event may carry beyond its own allowlist. */
const common = new Set([
  "install_id",
  "product",
  "version",
  "root_domain",
  "$process_person_profile",
  "$geoip_disable",
  "$lib",
]);
const allowed: Record<string, ReadonlySet<string>> = {
  instance_started: new Set([
    "channel",
    "os",
    "arch",
    "apps",
    "accounts",
    "users",
    "organizations",
  ]),
  feedback_submitted: new Set(["message"]),
  tool_execution_started: new Set(["source", "client_name", "resumed"]),
  tool_execution_completed: new Set([
    "source",
    "client_name",
    "resumed",
    "outcome",
    "ok",
    "duration_ms",
    "error_type",
    "status_code",
  ]),
  product_operation_started: new Set(["source", "client_name", "area", "operation"]),
  product_operation_completed: new Set([
    "source",
    "client_name",
    "area",
    "operation",
    "outcome",
    "ok",
    "duration_ms",
    "error_type",
    "status_code",
  ]),
};

/** Every event is personless, carries the install ID and stays within its allowlist. */
const expectAnonymous = (
  events: readonly DeliveredEvent[],
  product: "cli" | "self-host",
  install: string,
) => {
  for (const event of events) {
    expect(event.properties).toMatchObject({
      install_id: install,
      product,
      $process_person_profile: false,
      $geoip_disable: true,
    });
    expect(event.properties).not.toHaveProperty("$groups");
    expect(event.properties).not.toHaveProperty("$set");
    const permitted = allowed[event.event];
    if (permitted !== undefined)
      for (const key of Object.keys(event.properties))
        expect(common.has(key) || permitted.has(key), `${event.event}.${key}`).toBe(true);
  }
};

layer(HostedLive, { excludeTestServices: true })("Self-host instance analytics", (it) => {
  it.effect(scenarios.selfHostAnalytics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const target = yield* Target;
        const organization = actors.organization;
        const started = yield* awaitAnalytics((events) =>
          events.some((event) => event.event === "instance_started"),
        );
        const startup = started.events.find((event) => event.event === "instance_started");
        if (startup === undefined) return yield* Effect.die("instance_started is missing");
        const install = startup.distinct_id;
        expect(install).toMatch(uuid);
        expect(startup.properties).toMatchObject({
          install_id: install,
          product: "self-host",
          ...(yield* reportedBuild),
          root_domain: "private",
        });
        for (const count of ["apps", "accounts", "users", "organizations"])
          expect(startup.properties[count], count).toEqual(expect.any(Number));

        const viewer = (actor: Session) =>
          api.request(actor, "GET", "/api/viewer").pipe(Effect.flatMap((r) => body(Viewer, r)));
        const [owner, member] = yield* Effect.all([viewer(actors.owner), viewer(actors.member)]);
        const root = `/api/organizations/${organization.id}`;

        // User-chosen names reach the product but never the batch.
        const group = "Zebra canary analytics group";
        const created = yield* api.request(actors.owner, "POST", `${root}/groups`, {
          name: group,
          description: "Quokka canary description",
          memberIds: [],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);

        // An agent sends feedback through the Executor app's feedback.submit tool.
        const { app, profile } = yield* managementApp(actors.owner);
        const ownerMessage = "Owner feedback through the Executor app tool";
        const called = yield* api.request(
          actors.owner,
          "POST",
          `${root}/apps/${app.id}/tools/call`,
          {
            profile: profile.id,
            tool: "feedback.submit",
            kind: "mutation",
            input: { body: { message: ownerMessage } },
          },
        );
        // Hosted tool calls return the tool's value.
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        expect(called.body).toEqual({ status: "accepted" });
        const memberMessage = "Member feedback through the hosted API";
        const accepted = yield* api.request(actors.member, "POST", `${root}/feedback`, {
          message: memberMessage,
        });
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ status: "accepted" });

        const delivered = yield* awaitAnalytics(
          (events) =>
            events.some((event) => event.properties.message === ownerMessage) &&
            events.some((event) => event.properties.message === memberMessage) &&
            events.some((event) => event.event === "tool_execution_completed") &&
            events.some(
              (event) =>
                event.event === "product_operation_completed" && event.properties.area === "groups",
            ),
        );
        const { events, text } = delivered;
        expectAnonymous(events, "self-host", install);
        for (const event of events) expect(event.properties.root_domain).toBe("private");

        // People get a stable HMAC per instance, never their user ID.
        const ownerFeedback = events.find((event) => event.properties.message === ownerMessage);
        const memberFeedback = events.find((event) => event.properties.message === memberMessage);
        const ownerId = ownerFeedback?.distinct_id ?? "";
        const memberId = memberFeedback?.distinct_id ?? "";
        expect(ownerId).toMatch(/^[0-9a-f]{64}$/);
        expect(memberId).toMatch(/^[0-9a-f]{64}$/);
        expect(ownerId).not.toBe(memberId);
        expect(ownerId).not.toBe(install);
        const groupOperation = events.find(
          (event) =>
            event.event === "product_operation_completed" && event.properties.area === "groups",
        );
        expect(groupOperation?.distinct_id).toBe(ownerId);
        expect(groupOperation?.properties).toMatchObject({
          operation: "create",
          outcome: "success",
          ok: true,
          status_code: 200,
        });
        const toolCall = events.find((event) => event.event === "tool_execution_completed");
        expect(toolCall?.distinct_id).toBe(ownerId);
        expect(toolCall?.properties).toMatchObject({ outcome: "success", ok: true });

        for (const secret of [
          owner.userId,
          member.userId,
          "example.test",
          organization.id,
          app.id,
          profile.id,
          "feedback.submit",
          group,
          "Quokka canary",
          new URL(target.metadata.origin).host,
        ])
          expect(text.includes(secret), `analytics contain ${secret}`).toBe(false);
        // The fixture's slug is a common word, so compare whole values.
        for (const event of events)
          expect(Object.values(event.properties)).not.toContain(organization.slug);
      }),
    ),
  );

  it.effect(scenarios.selfHostAnalyticsOptOut.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const root = `/api/organizations/${actors.organization.id}`;
        const refused = yield* api.request(actors.owner, "POST", `${root}/feedback`, {
          message: "Feedback while analytics are off",
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual(disabled);
        // The agent sees the same explanation through the Executor app.
        const { app, profile } = yield* managementApp(actors.owner);
        const called = yield* api.request(
          actors.owner,
          "POST",
          `${root}/apps/${app.id}/tools/call`,
          {
            profile: profile.id,
            tool: "feedback.submit",
            kind: "mutation",
            input: { body: { message: "Agent feedback while analytics are off" } },
          },
        );
        expect(called.body).toMatchObject({
          _tag: "ToolCallFailed",
          response: { code: "FeedbackDisabled", status: 409, message: disabled.message },
        });
        // Shutdown sends whatever a running sender buffered, so an empty file is conclusive.
        yield* serverControl("stop");
        expect((yield* deliveredAnalytics).text).toBe("");
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Self-host root domain", (it) => {
  const rootDomain = (expected: string, absent: readonly string[]) =>
    Effect.gen(function* () {
      const { events, text } = yield* awaitAnalytics((events) =>
        events.some((event) => event.event === "instance_started"),
      );
      for (const event of events) expect(event.properties.root_domain).toBe(expected);
      for (const value of absent) expect(text.includes(value), value).toBe(false);
    });

  it.effect(scenarios.selfHostAnalyticsRootDomain.title, (context) =>
    withCase(context, rootDomain("acme.co.uk", ["executor.platform", "platform.acme"])),
  );

  it.effect(scenarios.selfHostAnalyticsTunnelDomain.title, (context) =>
    withCase(context, rootDomain("private", ["agent-box", "ngrok"])),
  );
});

layer(TestLive, { excludeTestServices: true })("Local instance analytics", (it) => {
  it.effect(scenarios.localAnalytics.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const target = yield* Target;
        const agent = yield* localAgent;
        const started = yield* awaitAnalytics((events) =>
          events.some((event) => event.event === "instance_started"),
        );
        const startup = started.events.find((event) => event.event === "instance_started");
        const install = startup?.distinct_id ?? "";
        expect(install).toMatch(uuid);
        expect(startup?.properties).toMatchObject({
          install_id: install,
          product: "cli",
          ...(yield* reportedBuild),
          apps: expect.any(Number),
          accounts: expect.any(Number),
        });
        expect(startup?.properties).not.toHaveProperty("root_domain");

        // The agent-facing document has the same operation as hosted Executor.
        const document = yield* api.request(agent, "GET", "/openapi.json");
        expect(document.body).toMatchObject({
          paths: { "/v1/feedback": { post: { operationId: "feedback.submit" } } },
        });
        const executor = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          yield* api.request(agent, "GET", "/v1/apps?owner=executor-local&name=Executor"),
        );
        const app = executor[0]?.id ?? "";
        const profiles = yield* body(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          yield* api.request(agent, "GET", `/v1/apps/${app}/profiles?owner=executor-local`),
        );
        const profile = profiles[0]?.id ?? "";
        const message = "Local feedback through the Executor app tool";
        const called = yield* api.request(agent, "POST", "/v1/tools/call", {
          app,
          profile,
          tool: "feedback.submit",
          kind: "mutation",
          input: { body: { message } },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(200);
        const result = yield* body(Completed, called);
        expect(result.toolError, JSON.stringify(result.value)).toBeUndefined();

        // A failed call records its outcome and error type, never its tool name or input.
        const canary = "zebra-canary-tool";
        const missing = yield* api.request(agent, "POST", "/v1/tools/call", {
          app,
          profile,
          tool: canary,
          kind: "query",
          input: { note: "Quokka canary input" },
        });
        expect(missing.status).not.toBe(200);

        const { events, text } = yield* awaitAnalytics(
          (events) =>
            events.some((event) => event.properties.message === message) &&
            events.filter((event) => event.event === "tool_execution_completed").length >= 2,
        );
        expectAnonymous(events, "cli", install);
        for (const event of events) expect(event.distinct_id).toBe(install);
        const outcomes = events
          .filter((event) => event.event === "tool_execution_completed")
          .map((event) => event.properties);
        expect(outcomes).toContainEqual(
          expect.objectContaining({ source: "api", outcome: "success", ok: true }),
        );
        expect(outcomes).toContainEqual(
          expect.objectContaining({ source: "api", outcome: "failure", ok: false }),
        );
        for (const secret of [
          app,
          profile,
          canary,
          "Quokka canary",
          "feedback.submit",
          Redacted.value(target.apiKey),
          new URL(target.metadata.origin).host,
        ])
          expect(text.includes(secret), `analytics contain ${secret}`).toBe(false);
      }),
    ),
  );

  it.effect(scenarios.localAnalyticsOptOut.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const agent = yield* localAgent;
        const refused = yield* api.request(agent, "POST", "/v1/feedback", {
          message: "Feedback while analytics are off",
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual(disabled);
        // Shutdown sends whatever a running sender buffered, so an empty file is conclusive.
        yield* serverControl("stop");
        expect((yield* deliveredAnalytics).text).toBe("");
      }),
    ),
  );
});
