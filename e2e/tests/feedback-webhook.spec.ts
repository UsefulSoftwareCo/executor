/** Real self-host feedback requests wait for the operator's HTTP receiver. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { managementApp } from "../support/management-app.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { deliveredAnalyticsWholeEnvironment } from "../support/instance-analytics.ts";

const Payload = Schema.Struct({
  message: Schema.String,
  submittedAt: Schema.String,
  organization: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  caller: Schema.Struct({ source: Schema.String }),
  instanceOrigin: Schema.String,
  title: Schema.String,
  body: Schema.String,
});

const exercise = (analyticsOff: boolean) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const target = yield* Target;
    const root = `/api/organizations/${actors.organization.id}`;
    const post = (message: string) =>
      api.request(actors.owner, "POST", `${root}/feedback`, { message });
    if (analyticsOff) {
      const disabled = yield* post("No receiver configured");
      expect(disabled.status).toBe(409);
      expect(disabled.body).toMatchObject({ _tag: "FeedbackDisabled" });
    }
    const received = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const requests: { authorization: string | undefined; payload: typeof Payload.Type }[] = [];
    let status = 204;
    let hold = true;
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      requests.push({
        authorization: request.headers.authorization,
        payload: yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Payload))),
      });
      yield* Deferred.succeed(received, undefined);
      if (hold) yield* Deferred.await(release);
      if (status === 408) return yield* Effect.never;
      return HttpServerResponse.empty({ status, headers: { location: "/feedback" } });
    }).pipe(Effect.orDie);
    const services = yield* Layer.build(
      Layer.fresh(
        HttpRouter.serve(HttpRouter.add("POST", "/feedback", handler), {
          disableLogger: true,
          disableListenLog: true,
        }).pipe(
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
        ),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Feedback receiver needs TCP");
    const receiver = `http://127.0.0.1:${server.address.port}/feedback`;
    yield* serverControl("stop");
    yield* serverControl("environment", 200, {
      EXECUTOR_FEEDBACK_WEBHOOK_URL: receiver,
      EXECUTOR_FEEDBACK_WEBHOOK_SECRET: analyticsOff ? "" : "synthetic-feedback-secret",
    });
    yield* serverControl("start");
    const viewer = yield* body(
      Schema.Struct({ userId: Schema.String }),
      yield* api.request(actors.owner, "GET", "/api/viewer"),
    );
    let completed = false;
    const pending = yield* post("Operator feedback").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(received);
    expect(completed).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: analyticsOff ? undefined : "Bearer synthetic-feedback-secret",
      payload: {
        message: "Operator feedback",
        organization: { id: actors.organization.id },
        user: { id: viewer.userId, email: expect.stringContaining("@") },
        instanceOrigin: target.metadata.origin,
        title: "Executor feedback",
        caller: { source: "dashboard" },
        body: expect.stringContaining("From: "),
      },
    });
    expect(Number.isNaN(Date.parse(requests[0]!.payload.submittedAt))).toBe(false);
    hold = false;
    yield* Deferred.succeed(release, undefined);
    const accepted = yield* Fiber.join(pending);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ status: "accepted" });

    // Exercise the actual Executor app route as an agent does, not just the hosted endpoint.
    const { app } = yield* managementApp(actors.owner);
    const called = yield* api.request(actors.owner, "POST", `${root}/apps/${app.id}/tools/call`, {
      tool: "feedback.submit",
      kind: "mutation",
      input: { body: { message: "Agent operator feedback" } },
    });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    expect(called.body).toEqual({ status: "accepted" });
    expect(requests.at(-1)?.payload.message).toBe("Agent operator feedback");
    expect(requests.at(-1)?.payload.caller.source).toBe("api");

    status = 503;
    const rejected = yield* post("Receiver failure");
    expect(rejected.status).toBe(503);
    expect(rejected.body).toMatchObject({ _tag: "FeedbackUnavailable" });
    expect(JSON.stringify(rejected.body)).not.toContain(receiver);
    expect(requests).toHaveLength(3);
    status = 302;
    const redirected = yield* post("Receiver redirect");
    expect(redirected.status).toBe(503);
    expect(redirected.body).toMatchObject({ _tag: "FeedbackUnavailable" });
    expect(requests).toHaveLength(4);
    if (analyticsOff) {
      status = 408;
      const timedOut = yield* post("Receiver never responds");
      expect(timedOut.status).toBe(503);
      expect(timedOut.body).toMatchObject({ _tag: "FeedbackUnavailable" });
      expect(requests).toHaveLength(5);
    }

    // Empty URL is the same as unset; a secret alone must not enable delivery.
    yield* serverControl("stop");
    yield* serverControl("environment", 200, { EXECUTOR_FEEDBACK_WEBHOOK_URL: "" });
    yield* serverControl("start");
    const fallback = yield* post("Feedback after disabling the webhook");
    expect(fallback.status).toBe(analyticsOff ? 409 : 200);
    expect(requests).toHaveLength(analyticsOff ? 5 : 4);
    yield* serverControl("stop");
    const fs = yield* FileSystem.FileSystem;
    const logs = yield* fs.readFileString(`${target.directory}/server.log`);
    expect(logs).not.toContain(receiver);
    expect(logs).not.toContain("synthetic-feedback-secret");
    expect(logs).toContain("Feedback webhook delivery failed");
    const analytics = yield* deliveredAnalyticsWholeEnvironment;
    if (analyticsOff) expect(analytics.text).toBe("");
    else {
      expect(
        analytics.events.some(
          (event) => event.properties.message === "Feedback after disabling the webhook",
        ),
      ).toBe(true);
      expect(
        analytics.events.some((event) => event.properties.message === "Operator feedback"),
      ).toBe(false);
    }
  });

layer(HostedLive, { excludeTestServices: true })("Self-host feedback webhook", (it) => {
  it.effect(scenarios.feedbackWebhook.title, (context) => withHostedCase(context, exercise(false)));
  it.effect(scenarios.feedbackWebhookOptOut.title, (context) =>
    withHostedCase(context, exercise(true)),
  );
});
