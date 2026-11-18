/** Real self-host feedback requests file issues through the operator's GitHub API. */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import type { OperatorSettings } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";

const Issue = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Notification = Schema.Struct({
  message: Schema.String,
  body: Schema.String,
  issue: Schema.optionalKey(Schema.Struct({ url: Schema.String, number: Schema.Number })),
});
const token = "synthetic-github-token";
const issueUrl = "https://github.test/acme/feedback/issues/7";

const exercise = Effect.gen(function* () {
  const api = yield* Api;
  const actors = yield* Actors;
  const target = yield* Target;
  const post = (message: string) =>
    api.request(actors.owner, "POST", `/api/organizations/${actors.organization.id}/feedback`, {
      message,
    });
  const issues: {
    headers: Readonly<Record<string, string | undefined>>;
    issue: typeof Issue.Type;
  }[] = [];
  const notifications: (typeof Notification.Type)[] = [];
  let github = 201;
  let webhook = 204;
  const routes = Layer.mergeAll(
    // A base URL with a path, as GitHub Enterprise Server has.
    HttpRouter.add(
      "POST",
      "/api/v3/repos/acme/feedback/issues",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        issues.push({
          headers: request.headers,
          issue: yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Issue))),
        });
        return github === 201
          ? yield* HttpServerResponse.json({ html_url: issueUrl, number: 7 }, { status: 201 })
          : HttpServerResponse.empty({ status: github });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "POST",
      "/hook",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        notifications.push(
          yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Notification))),
        );
        return HttpServerResponse.empty({ status: webhook });
      }).pipe(Effect.orDie),
    ),
  );
  const services = yield* Layer.build(
    Layer.fresh(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("The GitHub API needs TCP");
  const receiver = `http://127.0.0.1:${server.address.port}`;
  const configure = (environment: typeof OperatorSettings.Type) =>
    Effect.gen(function* () {
      yield* serverControl("stop");
      yield* serverControl("environment", 200, environment);
      yield* serverControl("start");
    });

  // GitHub alone: the issue is the receipt.
  yield* configure({
    EXECUTOR_FEEDBACK_GITHUB_REPOSITORY: "acme/feedback",
    EXECUTOR_FEEDBACK_GITHUB_TOKEN: token,
    EXECUTOR_FEEDBACK_GITHUB_API_URL: `${receiver}/api/v3/`,
    EXECUTOR_FEEDBACK_GITHUB_LABELS: "feedback, from agents",
  });
  const message = `\n## Tool search hides ${"long ".repeat(40)}names\n\nExpected \`tools.search\` to list it.`;
  const filed = yield* post(message);
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  expect(filed.body).toEqual({ status: "accepted" });
  expect(issues).toHaveLength(1);
  expect(issues[0]!.headers).toMatchObject({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "executor-feedback",
  });
  const { title, body, labels } = issues[0]!.issue;
  expect(title.startsWith("Tool search hides long long")).toBe(true);
  expect(title).toHaveLength(120);
  expect(title.endsWith("…")).toBe(true);
  expect(labels).toEqual(["feedback", "from agents"]);
  expect(body.startsWith(message)).toBe(true);
  expect(body).toMatch(/\n- From: \S+@\S+/u);
  expect(body).toContain("\n- Source: dashboard");
  expect(body).toContain(`\n- Organization: ${actors.organization.id}`);
  expect(body).toContain(`\n- Instance: ${target.metadata.origin}`);
  expect(Number.isNaN(Date.parse(/\n- Submitted: (\S+)/u.exec(body)?.[1] ?? ""))).toBe(false);

  github = 422;
  const refused = yield* post("GitHub refuses this issue");
  expect(refused.status).toBe(503);
  expect(refused.body).toMatchObject({ _tag: "FeedbackUnavailable" });
  expect(JSON.stringify(refused.body)).not.toContain(receiver);
  expect(issues).toHaveLength(2);

  // With a webhook too, the notification links the issue and either receiver is a receipt.
  yield* configure({ EXECUTOR_FEEDBACK_WEBHOOK_URL: `${receiver}/hook` });
  github = 201;
  expect((yield* post("Both receivers")).status).toBe(200);
  expect(issues.at(-1)?.issue.title).toBe("Both receivers");
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    message: "Both receivers",
    issue: { url: issueUrl, number: 7 },
    body: expect.stringContaining(`\nIssue: ${issueUrl}`),
  });

  github = 500;
  expect((yield* post("Only the webhook")).status).toBe(200);
  expect(issues).toHaveLength(4);
  expect(notifications).toHaveLength(2);
  expect(notifications[1]!.issue).toBeUndefined();
  expect(notifications[1]!.body).toContain("\nIssue: not created");

  github = 201;
  webhook = 503;
  expect((yield* post("Only the issue")).status).toBe(200);
  expect(issues).toHaveLength(5);
  expect(notifications).toHaveLength(3);

  github = 500;
  const lost = yield* post("Neither receiver");
  expect(lost.status).toBe(503);
  expect(lost.body).toMatchObject({ _tag: "FeedbackUnavailable" });
  expect(issues).toHaveLength(6);
  expect(notifications).toHaveLength(4);

  // A repository without a usable token refuses feedback without calling GitHub.
  yield* configure({ EXECUTOR_FEEDBACK_WEBHOOK_URL: "", EXECUTOR_FEEDBACK_GITHUB_TOKEN: "" });
  github = 201;
  expect((yield* post("No token")).status).toBe(503);
  expect(issues).toHaveLength(6);

  yield* serverControl("stop");
  const fs = yield* FileSystem.FileSystem;
  const logs = yield* fs.readFileString(`${target.directory}/server.log`);
  expect(logs).not.toContain(receiver);
  expect(logs).not.toContain(token);
  expect(logs).toContain("Feedback GitHub issue delivery failed");
  expect(logs).toContain("Feedback webhook delivery failed");
  expect(logs).toContain("EXECUTOR_FEEDBACK_GITHUB_REPOSITORY must be owner/repository");
});

layer(HostedLive, { excludeTestServices: true })("Self-host feedback issues", (it) => {
  it.effect(scenarios.feedbackGithubIssues.title, (context) => withHostedCase(context, exercise));
});
