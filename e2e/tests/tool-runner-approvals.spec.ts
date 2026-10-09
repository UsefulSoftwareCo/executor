/**
 * A person running an approval-gated tool from the hosted dashboard reviews and answers it there,
 * and only there: the dashboard refuses approvals issued by MCP, schedules or another member.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, interval, mutation, object, string, router } from "apps";
const publish = mutation(
  { input: object({ title: string() }), approval: () => "user-approval" },
  async (_, input) => ({ published: input.title }),
);
export default defineApp({ accounts: {} }, async () => ({
  tools: router({ publish }),
  schedules: { nightly: interval({ minutes: 1 }, publish, { title: "From the schedule" }) },
}));`;
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Review = Schema.Struct({
  status: Schema.Literal("pending"),
  appName: Schema.String,
  request: Schema.Struct({
    status: Schema.Literal("approval-required"),
    requestId: Schema.String,
    invocation: Schema.Struct({ tool: Schema.String, input: Schema.Unknown }),
    elicitation: Schema.Struct({ message: Schema.String }),
  }),
});
const Key = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Runs = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
);
class Waiting extends Schema.TaggedError<Waiting>()("Waiting", {}) {}
const accept = { response: { action: "accept", content: {} } };
/** Another flow's request records no dashboard run; another member's belongs to their run. */
const unrecorded = { _tag: "ToolRunApprovalRefused", reason: "unrecorded" };
const anotherPerson = { _tag: "ToolRunApprovalRefused", reason: "another-person" };

/** The owner deploys the publisher; the scenario removes it when it ends. */
const deployPublisher = Effect.gen(function* () {
  const actors = yield* Actors,
    api = yield* Api;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const name = `Publisher ${randomUUID().slice(0, 8)}`;
  const app = yield* body(
    App,
    yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name,
      files: [{ path: "index.ts", content: source }, appsManifest],
    }),
  );
  const path = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", path).pipe(Effect.orDie));
  return { actors, api, prefix, name, app, path };
});
/** Read and answer a request through the dashboard routes, as `actor`. */
const throughDashboard = (actor: Session, approval: string, response: unknown = accept) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const read = yield* api.request(actor, "GET", approval);
    const answer = yield* api.request(actor, "POST", approval, response);
    return { read, answer };
  });

layer(HostedLive, { excludeTestServices: true })("Hosted tool runner approvals", (it) => {
  it.effect(scenarios.hostedToolRunnerApprovals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, api, name, app, path } = yield* deployPublisher;
        const browser = yield* Browser,
          oauth = yield* McpOAuth;
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeApi;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const agent = yield* api.session();
        const bearer = { authorization: `Bearer ${Redacted.value(grant.tokens).access_token}` };
        const call = { tool: "publish", kind: "mutation", input: { title: "From the API" } };

        // An API credential cannot present an approval, so its call still fails without running.
        const refused = yield* api.request(agent, "POST", `${path}/tools/call`, call, bearer);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ _tag: "ToolApprovalRequired" });
        expect(
          (yield* api.request(agent, "POST", `${path}/tools/run`, call, bearer)).status,
          "an API credential cannot start a dashboard run",
        ).toBe(403);

        // The API document lists only the browser session for the dashboard's run and review.
        const spec = yield* body(
          Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) }),
          yield* api.request(agent, "GET", "/openapi.json"),
        );
        const tools = "/api/organizations/{organization}/apps/{app}/tools";
        const browserSession = [{ browserSession: [] }];
        expect(spec.paths[`${tools}/run`]).toMatchObject({ post: { security: browserSession } });
        expect(spec.paths[`${tools}/approvals/{requestId}`]).toMatchObject({
          get: { security: browserSession },
          post: { security: browserSession },
        });
        expect(spec.paths[`${tools}/call`]).toMatchObject({
          post: { security: [{ oauth: ["executor"] }, { browserSession: [] }] },
        });
        // Scheduled-run reviews refuse bearer credentials too.
        expect(
          spec.paths["/api/organizations/{organization}/scheduled-runs/{run}/approval"],
        ).toMatchObject({ get: { security: browserSession }, post: { security: browserSession } });

        // The signed-in person starts a run; the review reads the saved call from the server.
        const started = yield* body(
          Pending,
          yield* api.request(actors.owner, "POST", `${path}/tools/run`, call),
        );
        const approval = `${path}/tools/approvals/${started.requestId}`;
        expect(
          (yield* api.request(agent, "GET", approval, undefined, bearer)).status,
          "an API credential cannot read the review",
        ).toBe(403);
        expect(
          (yield* api.request(
            agent,
            "POST",
            approval,
            { response: { action: "accept", content: {} } },
            bearer,
          )).status,
          "an API credential cannot approve a person's run",
        ).toBe(403);
        const review = yield* body(Review, yield* api.request(actors.owner, "GET", approval));
        expect(review.appName).toBe(name);
        expect(review.request.invocation).toMatchObject({
          tool: "publish",
          input: { title: "From the API" },
        });
        expect(review.request.elicitation.message).toContain('"title": "From the API"');
        const answered = yield* api.request(actors.owner, "POST", approval, {
          response: { action: "accept", content: {} },
        });
        expect(answered.status).toBe(200);
        expect(answered.body).toEqual({
          status: "answered",
          result: { status: "completed", value: { published: "From the API" } },
        });
        expect(
          (yield* api.request(actors.owner, "POST", approval, {
            response: { action: "accept", content: {} },
          })).body,
          "an answered request cannot run again",
        ).toEqual({ status: "unavailable" });

        yield* browser.use("Open the approval-gated tool", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools&tool=publish`),
        );
        const run = (title: string) =>
          browser.use(`Run publish with ${title}`, (page) =>
            page
              .getByLabel("Title", { exact: true })
              .fill(title)
              .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
          );
        yield* run("Draft notes");
        const shown = yield* browser.use("The review names the tool and its arguments", (page) =>
          page
            .getByRole("heading", { name: "Review tool request", exact: true })
            .waitFor()
            .then(() =>
              Promise.all([
                page.getByText(`${name} · publish`, { exact: true }).count(),
                page.getByText('"title": "Draft notes"', { exact: false }).count(),
                page.getByRole("region", { name: "Tool result", exact: true }).count(),
              ]),
            ),
        );
        expect(shown).toEqual([1, 1, 0]);
        yield* browser.checkpoint("Review before the tool runs");
        yield* browser.use("Decline the run", (page) =>
          page.getByRole("button", { name: "Decline", exact: true }).click(),
        );
        expect(
          yield* browser.use("Declining does not run the tool", (page) =>
            page
              .getByText("Declined. Executor will not resume this saved call.", { exact: true })
              .waitFor()
              .then(() => page.getByRole("region", { name: "Tool result", exact: true }).count()),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Declined run");
        yield* run("Launch notes");
        yield* browser.use("Approve the new run", (page) =>
          page
            .getByText('"title": "Launch notes"', { exact: false })
            .waitFor()
            .then(() => page.getByRole("button", { name: "Approve", exact: true }).click()),
        );
        const result = yield* browser.use("Approving runs the saved call", (page) =>
          page
            .getByText("Approved. The tool ran, and its result is below.", { exact: true })
            .waitFor()
            .then(() =>
              page.getByRole("region", { name: "Tool result", exact: true }).textContent(),
            ),
        );
        expect(result).toContain('"published": "Launch notes"');
        yield* browser.checkpoint("Approved run with its result");
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );

  it.effect(scenarios.hostedToolRunnerApprovalOrigins.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, api, prefix, app, path } = yield* deployPublisher;
        const mcp = yield* McpClient;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Dashboard approval refusal",
        });
        expect(created.status).toBe(200);
        const token = yield* body(Key, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );

        // The owner's own MCP program pauses. Its request is answered only by MCP resume.
        const client = yield* mcp.connect(token.key, "dashboard-refusal", {
          organization: actors.organization.id,
        });
        const paused = yield* client.use("Pause an approval-gated MCP call", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(app.slug)}].publish({ title: "From MCP" })`,
              },
            },
            undefined,
            { signal },
          ),
        );
        const fromMcp = yield* Schema.decodeUnknownEffect(Pending)(paused.structuredContent);
        const mcpRefused = yield* throughDashboard(
          actors.owner,
          `${path}/tools/approvals/${fromMcp.requestId}`,
        );
        expect(mcpRefused.read.status, "the dashboard cannot read an MCP approval").toBe(403);
        expect(mcpRefused.read.body).toMatchObject(unrecorded);
        expect(mcpRefused.answer.status, "the dashboard cannot answer an MCP approval").toBe(403);
        expect(mcpRefused.answer.body).toMatchObject(unrecorded);
        const resumed = yield* client.use("MCP resume still runs the call", (client, signal) =>
          client.callTool(
            {
              name: "resume",
              arguments: { requestId: fromMcp.requestId, response: { action: "accept" } },
            },
            undefined,
            { signal },
          ),
        );
        expect(resumed.structuredContent).toMatchObject({
          status: "completed",
          execution: { ok: true, value: { published: "From MCP" } },
        });

        // A scheduled run waits for its own review, which an app manager answers.
        const schedule = `${path}/schedules/nightly`;
        expect(
          (yield* api.request(actors.owner, "PATCH", schedule, {
            enabled: true,
            approvalMode: "browser",
          })).status,
        ).toBe(200);
        const waitFor = (status: string) =>
          api.request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`).pipe(
            Effect.flatMap((response) => body(Runs, response)),
            Effect.flatMap((runs) => {
              const found = runs.find((run) => run.name === "nightly" && run.status === status);
              return found === undefined ? Effect.fail(new Waiting()) : Effect.succeed(found);
            }),
            Effect.retry({
              while: (error) => error instanceof Waiting,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout("20 seconds"),
          );
        expect((yield* api.request(actors.owner, "POST", `${schedule}/run`)).status).toBe(200);
        const waiting = yield* waitFor("awaiting-approval");
        expect(
          (yield* api.request(actors.owner, "PATCH", schedule, { enabled: false })).status,
        ).toBe(200);
        const review = `${prefix}/scheduled-runs/${waiting.id}/approval`;
        const scheduled = yield* body(
          Schema.Struct({ request: Schema.Struct({ requestId: Schema.String }) }),
          yield* api.request(actors.owner, "GET", review),
        );
        const scheduleRefused = yield* throughDashboard(
          actors.owner,
          `${path}/tools/approvals/${scheduled.request.requestId}`,
        );
        expect(scheduleRefused.read.status, "the dashboard cannot read a scheduled approval").toBe(
          403,
        );
        expect(scheduleRefused.read.body).toMatchObject(unrecorded);
        expect(
          scheduleRefused.answer.status,
          "the dashboard cannot answer a scheduled approval",
        ).toBe(403);
        expect(scheduleRefused.answer.body).toMatchObject(unrecorded);
        expect((yield* api.request(actors.owner, "POST", review, accept)).body).toEqual({
          status: "answered",
        });
        yield* waitFor("succeeded");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.hostedToolRunnerApprovalMembers.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { actors, api, app, path } = yield* deployPublisher;
        // Every member may run the app, so only the run's own person decides it.
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const run = (actor: Session, title: string) =>
          api
            .request(actor, "POST", `${path}/tools/run`, {
              tool: "publish",
              kind: "mutation",
              input: { title },
            })
            .pipe(Effect.flatMap((response) => body(Pending, response)));
        const secret = `Private ${randomUUID()}`;
        const owners = yield* run(actors.owner, secret);
        const approval = `${path}/tools/approvals/${owners.requestId}`;

        const read = yield* api.request(actors.member, "GET", approval);
        expect(read.status, "another member cannot read the owner's arguments").toBe(403);
        expect(read.body).toMatchObject(anotherPerson);
        expect(JSON.stringify(read.body)).not.toContain(secret);
        for (const response of [
          { action: "accept", content: {} },
          { action: "decline" },
          { action: "cancel" },
        ]) {
          const answer = yield* api.request(actors.member, "POST", approval, { response });
          expect(answer.status, `another member cannot ${response.action} it`).toBe(403);
          expect(answer.body).toMatchObject(anotherPerson);
        }
        // The member's runner, handed the owner's request through one run response, shows whose
        // run it is and what to do instead of a retry. The review's refusal is the real server's.
        const browser = yield* Browser;
        yield* browser.login(actors.member);
        yield* browser.use("Hand the member's runner the owner's request", (page) =>
          page.route(
            `**/apps/${app.id}/tools/run`,
            (route) =>
              route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(owners),
              }),
            { times: 1 },
          ),
        );
        yield* browser.use("The member opens the tool", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools&tool=publish`),
        );
        yield* browser.use("The member runs it", (page) =>
          page
            .getByLabel("Title", { exact: true })
            .fill("Member draft")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        const notice = yield* browser.use("The refusal names whose run it is", (page) => {
          const alert = page.getByRole("alert").filter({ hasText: "Another person’s run" });
          return alert
            .waitFor()
            .then(() =>
              Promise.all([
                alert.locator("p").allTextContents(),
                page.getByRole("button", { name: "Try again", exact: true }).count(),
                page.locator("body").innerText(),
              ]),
            );
        });
        expect(notice.slice(0, 2)).toEqual([
          [
            "Another person started this run from the Tools tab, so only they can review or answer it.",
            "Leave this request to them. To make this call yourself, run the tool again.",
          ],
          0,
        ]);
        expect(notice[2]).not.toContain(secret);
        yield* browser.checkpoint("Another person's run");

        // The member answers their own run; the owner cannot read it.
        const members = yield* run(actors.member, "Member draft");
        const own = `${path}/tools/approvals/${members.requestId}`;
        expect((yield* api.request(actors.member, "GET", own)).body).toMatchObject({
          status: "pending",
        });
        const ownerRead = yield* api.request(actors.owner, "GET", own);
        expect(ownerRead.status, "the owner cannot read a member's run").toBe(403);
        expect(ownerRead.body).toMatchObject(anotherPerson);
        expect(
          (yield* api.request(actors.member, "POST", own, { response: { action: "decline" } }))
            .body,
        ).toEqual({
          status: "answered",
          result: { status: "denied", requestId: members.requestId },
        });

        // The refused answers consumed nothing: the owner still reviews and runs the call.
        const review = yield* body(Review, yield* api.request(actors.owner, "GET", approval));
        expect(review.request.invocation.input).toEqual({ title: secret });
        expect((yield* api.request(actors.owner, "POST", approval, accept)).body).toEqual({
          status: "answered",
          result: { status: "completed", value: { published: secret } },
        });
      }),
    ),
  );
});
