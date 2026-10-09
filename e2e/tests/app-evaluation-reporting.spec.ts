/**
 * App evaluation failures explain the likely cause and who can act, and every one reports on the
 * REST routes. Their fields come from the app's isolate, whose code can replace the fetch an answer
 * arrives through, so the copy never claims the cause and nothing skips reporting because of them.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Page } from "playwright";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { awaitSentryEvents, sentryEvents, traceExceptionTypes } from "../support/sentry-events.ts";
import { freePort } from "../support/ports.ts";
import { appsManifest, withApps } from "../support/apps-release.ts";

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
});

/**
 * MCP servers that fail at known points. `/lost` opens a session and then no longer recognizes
 * it, as one run on several instances without shared sessions does: every request after
 * initialize answers 404. `/stateless` issues no session and answers 404 the same way.
 * `/unsupported` answers initialize with a protocol version no client supports, a failure the
 * client raises itself without an HTTP status or JSON-RPC error. `/silent` never answers.
 * `/github/` answers every request 404, as GitHub answers a git request without credentials for a
 * repository that is not public. `initializations` counts the initialize requests each path received.
 */
const failingMcpServer = Effect.gen(function* () {
  const initializations = { lost: 0, stateless: 0, unsupported: 0 };
  const handler = (path: keyof typeof initializations) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
      const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRequest))(
        yield* request.text,
      );
      if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
      if (message.method !== "initialize") return HttpServerResponse.empty({ status: 404 });
      initializations[path]++;
      return yield* HttpServerResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion:
              path === "unsupported" ? "1999-01-01" : message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Failing MCP fixture", version: "1.0.0" },
          },
        },
        path === "lost" ? { headers: { "mcp-session-id": randomUUID() } } : {},
      );
    });
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("*", "/lost", handler("lost")),
        HttpRouter.add("*", "/stateless", handler("stateless")),
        HttpRouter.add("*", "/unsupported", handler("unsupported")),
        HttpRouter.add("*", "/silent", Effect.never),
        HttpRouter.add("*", "/github/*", HttpServerResponse.empty({ status: 404 })),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  const origin = `http://127.0.0.1:${server.address.port}`;
  return {
    url: (path: keyof typeof initializations | "silent" | "github") => `${origin}/${path}`,
    initializations,
  };
});

/** The manifest of an app that uses `apps/mcp`. */
const mcpManifest = {
  path: "package.json",
  content: JSON.stringify({
    dependencies: withApps({
      "@modelcontextprotocol/client": "2.0.0",
      "@modelcontextprotocol/core": "2.0.0",
    }),
  }),
};

/** An app whose tools come from the MCP server at `url`, waiting `timeoutMs` for it if given. */
const mcpAppFiles = (url: string, timeoutMs?: number) => [
  mcpManifest,
  {
    path: "index.ts",
    content: `import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => ({ tools: await mcpRouter({ url: ${JSON.stringify(url)}${timeoutMs === undefined ? "" : `, timeoutMs: ${timeoutMs}`} }) }));`,
  },
];

/**
 * An app whose skills come from GitHub, with every request sent through `fetch`. `options` adds
 * loader options, such as a path.
 */
const githubSkillsApp = (
  fetch: string,
  options = "",
) => `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { githubSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: () => githubSkills({
    repo: "synthetic/missing-skills",
    signal: ctx.signal,
    fetch: ${fetch},${options}
  }) }),
}));`;

/** A fetch that answers every request with `response`, whatever was asked. */
const answering = (response: string) => `async () => ${response}`;

/** A fetch that sends each request through Executor's `ctx.fetch` to `origin` instead. */
const through = (origin: string) => `(input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return ctx.fetch(${JSON.stringify(origin)} + url.pathname + url.search, init);
    }`;

/** An app whose skills come from the published index at `url`, read with `fetch` if given. */
const wellKnownSkillsApp = (
  url: string,
  fetch = "",
) => `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: () => wellKnownSkills({ url: ${JSON.stringify(url)}, signal: ctx.signal${fetch} }) }),
}));`;

const Failure = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  message: Schema.String,
  recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
});

/** What MCP execute reports for an app it could not load. */
const Unavailable = Schema.Struct({
  unavailableApps: Schema.Array(Schema.Struct({ app: Schema.String, reason: Schema.String })),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Resumed = Schema.Struct({ status: Schema.Literal("completed"), ...Unavailable.fields });

layer(HostedLive, { excludeTestServices: true })("App evaluation reporting", (it) => {
  it.effect(scenarios.appEvaluationReporting.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          mcp = yield* McpClient,
          target = yield* Target;
        const cloud = target.metadata.target === "cloud";
        const prefix = `/api/organizations/${actors.organization.id}`;
        const latestTrace = evidence.requests.pipe(
          Effect.map((requests) => {
            const id = requests.at(-1)?.traceId;
            if (id === undefined) throw new Error("The request trace was not recorded");
            return id;
          }),
        );
        const deploy = (label: string, files: ReadonlyArray<{ path: string; content: string }>) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${label} ${randomUUID().slice(0, 8)}`,
              files,
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const app = yield* body(App, deployed);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });
        /** Read a failing endpoint; its error, status and trace. */
        const failing = (path: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "GET", path);
            const trace = yield* latestTrace;
            expect(response.status, JSON.stringify(response.body)).toBe(502);
            return { trace, error: yield* body(Failure, response) };
          });

        const server = yield* failingMcpServer;
        const mcpApp = yield* deploy("Session-losing MCP", mcpAppFiles(server.url("lost")));
        const statelessApp = yield* deploy("Stateless MCP", mcpAppFiles(server.url("stateless")));
        const unsupportedApp = yield* deploy(
          "Unsupported MCP",
          mcpAppFiles(server.url("unsupported")),
        );
        const silentApp = yield* deploy("Silent MCP", mcpAppFiles(server.url("silent"), 1_000));
        // Nothing listens on this port, so the request fails before any server answers: the same
        // failure a fault in Executor's own network would cause. The app's fetch rejects.
        const unanswered = yield* deploy(
          "Unanswered MCP",
          mcpAppFiles(`http://127.0.0.1:${yield* freePort}/mcp`),
        );
        // A credential handle not sealed for this app: Executor's network refuses the request.
        const egress = yield* deploy(
          "Refused MCP egress",
          mcpAppFiles(`${server.url("lost")}?key=exsec_00_`),
        );
        // GitHub's answer for a repository it does not show without credentials, through `ctx.fetch`
        // to the fixture instead of github.com.
        const missing = yield* deploy("Missing skill repository", [
          { path: "index.ts", content: githubSkillsApp(through(server.url("github"))) },
          appsManifest,
        ]);
        // The same 404, made up by the app's own fetch: the copy is the same, and it reports too.
        const madeUp = yield* deploy("Made-up skill answer", [
          {
            path: "index.ts",
            content: githubSkillsApp(answering("new Response(null, { status: 404 })")),
          },
          appsManifest,
        ]);
        // The app's fetch replaces a request Executor's network could not complete, which rejects,
        // with the 404 a missing repository gets.
        const replaced = yield* deploy("Replaced skill failure", [
          {
            path: "index.ts",
            content: githubSkillsApp(`(input, init) => {
      const missing = () => new Response(null, { status: 404 });
      return ctx.fetch("http://127.0.0.1:${yield* freePort}/", init).then(
        (response) => (response.ok ? response : missing()),
        missing,
      );
    }`),
          },
          appsManifest,
        ]);
        const invalid = yield* deploy("Invalid skill source", [
          {
            path: "index.ts",
            content: githubSkillsApp(
              answering("new Response(null, { status: 404 })"),
              `\n    path: "../outside",`,
            ),
          },
          appsManifest,
        ]);
        const unreadable = yield* deploy("Unreadable skill source", [
          {
            path: "index.ts",
            content: githubSkillsApp(
              answering('new Response("not a git response", { status: 200 })'),
            ),
          },
          appsManifest,
        ]);
        // Executor's network cannot send this request, so the app's fetch rejects.
        const closedSkills = yield* deploy("Unanswered skill source", [
          {
            path: "index.ts",
            content: wellKnownSkillsApp(
              `http://127.0.0.1:${yield* freePort}/index.json`,
              ", fetch: ctx.fetch",
            ),
          },
          appsManifest,
        ]);
        // The platform's own fetch: Executor's refusal arrives as its marked HTTP 421 response.
        const refusedSkills = yield* deploy("Refused skill egress", [
          {
            path: "index.ts",
            content: wellKnownSkillsApp(`${server.url("lost")}/index.json?key=exsec_00_`),
          },
          appsManifest,
        ]);
        // Every field a lost session carries, thrown by the app's code: its caller reads the
        // app's error, which reports like the others.
        const forged = yield* deploy("Thrown MCP error", [
          mcpManifest,
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
import { McpError } from "apps/mcp";
export default defineApp({ accounts: {} }, async () => {
  throw new McpError({ phase: "discover", reason: "request", status: 404, session: true });
});`,
          },
        ]);
        const throwingFactory = [
          {
            path: "index.ts",
            content: `import { defineApp } from "apps";
export default defineApp({ accounts: {} }, async () => {
  throw new TypeError("Synthetic failure in the factory");
});`,
          },
          appsManifest,
        ];
        const throwing = yield* deploy("Throwing factory", throwingFactory);
        // An execution that waits for approval and then searches an app that fails to load.
        const searchedLater = yield* deploy("Factory searched after approval", throwingFactory);
        const approval = yield* deploy("Approval before search", [
          {
            path: "index.ts",
            content: `import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({ accounts: {} }, async () => ({ tools: router({
  approved: mutation({ input: object({}), approval: always() }, async () => "approved"),
}) }));`,
          },
          appsManifest,
        ]);

        // A 404 on the session the app reports: it may have expired, and a new listing can help.
        const lost = yield* failing(`${prefix}/apps/${mcpApp.id}/tools`);
        expect(lost.error.message).toBe(
          "The app reported HTTP 404 while listing tools with a session; the server may no longer recognize it.",
        );
        expect(lost.error.recovery.action).toContain(
          "check that the MCP server keeps its sessions",
        );

        // Without a session the server issued, a 404 is a refusal, not a lost session.
        const stateless = yield* failing(`${prefix}/apps/${statelessApp.id}/tools`);
        expect(stateless.error.message).toBe(
          "The app’s MCP server refused the request while listing its tools (HTTP 404).",
        );
        expect(stateless.error.recovery.action).toBe(
          "Check the app’s MCP server URL and access requirements.",
        );

        // A server that does not answer in time.
        const silent = yield* failing(`${prefix}/apps/${silentApp.id}/tools`);
        expect(silent.error.message).toBe(
          "The app’s MCP server did not respond in time while connecting.",
        );

        // A skill repository GitHub does not show without credentials: what to check and how to read
        // a private one, without claiming the repository does not exist.
        const absent = yield* failing(`${prefix}/apps/${missing.id}/skill-bundle`);
        const absentCopy =
          "Reading GitHub repository synthetic/missing-skills without credentials returned HTTP 404: it may not exist, or it may be private. To read a private repository, pass a GitHub account and its token.";
        expect(absent.error.message).toBe(absentCopy);
        expect(absent.error.recovery.action).toBe(
          "Check the repository the app’s skill source names. If it is private, pass a GitHub account and its token to the skill loader.",
        );
        expect(absent.error.recovery.instructions).toContain(
          "This does not show that the repository does not exist.",
        );
        expect(absent.error.recovery.instructions).toContain("may be private");
        expect(absent.error.recovery.instructions).not.toContain("retrying will not help");

        // Settings the loader refuses get no claim about a missing repository, nor about whether a
        // request was sent or refused.
        const refused = yield* failing(`${prefix}/apps/${invalid.id}/skill-bundle`);
        expect(refused.error.message).toBe("The GitHub skill source settings are not valid.");
        expect(refused.error.recovery.action).toBe(
          "Check the app’s skill source settings and the files it lists.",
        );
        expect(refused.error.recovery.instructions).toContain(
          "The skill loader reported a problem with its source",
        );
        expect(refused.error.recovery.instructions).not.toContain("refused");
        expect(refused.error.recovery.instructions).not.toContain("repository the skill source");

        // Agents get the same explanations over MCP.
        const issued = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "App evaluation reporting",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: issued.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(issued.key, "app-evaluation-reporting", {
          organization: actors.organization.id,
        });
        const executed = yield* client.use(
          "Call a tool of the session-losing app",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `return await tools[${JSON.stringify(mcpApp.slug)}].anything({});`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const mcpTrace = yield* latestTrace;
        const agentReason =
          (yield* Schema.decodeUnknownEffect(Unavailable)(
            executed.structuredContent,
          )).unavailableApps.find((entry) => entry.app === mcpApp.id)?.reason ?? "";
        expect(agentReason).toContain("the server may no longer recognize it");
        const skills = yield* client.use("List the missing repository's skills", (client, signal) =>
          client.callTool({ name: "skills", arguments: { app: missing.slug } }, undefined, {
            signal,
          }),
        );
        const skillsTrace = yield* latestTrace;
        const agentSkills = JSON.stringify(skills.structuredContent ?? skills.content);
        expect(skills.isError).toBe(true);
        expect(agentSkills).toContain("it may not exist, or it may be private");
        expect(agentSkills).toContain("Check the repository the app’s skill source names");
        // The program parks for approval, so the request that started it ends. Only the search
        // after the resume discovers the failing app: the resume request reports it.
        const parked = yield* client.use(
          "Start an execution that waits for approval",
          (client, signal) =>
            client.callTool(
              {
                name: "execute",
                arguments: {
                  code: `await tools[${JSON.stringify(approval.slug)}].approved({});
return await tools.search({ query: "anything", namespace: ${JSON.stringify(searchedLater.slug)} });`,
                },
              },
              undefined,
              { signal },
            ),
        );
        const parkedTrace = yield* latestTrace;
        const pending = yield* Schema.decodeUnknownEffect(Pending)(parked.structuredContent);
        const resumed = yield* client.use("Approve and search the failing app", (client, signal) =>
          client.callTool(
            {
              name: "resume",
              arguments: { requestId: pending.requestId, response: { action: "accept" } },
            },
            undefined,
            { signal },
          ),
        );
        const resumedTrace = yield* latestTrace;
        const resumedResult = yield* Schema.decodeUnknownEffect(Resumed)(resumed.structuredContent);
        expect(resumedResult.unavailableApps.map((entry) => entry.app)).toEqual([searchedLater.id]);

        // The Tools page offers a retry, which opens a new session with the server.
        yield* browser.login(actors.owner);
        yield* browser.use("Open the session-losing app's Tools page", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${mcpApp.id}?view=tools`),
        );
        const alert = (page: Page) =>
          page.getByRole("alert", { name: "MCP session may have expired", exact: true });
        const copy = yield* browser.use("Read the Tools error", (page) => alert(page).innerText());
        expect(copy).toContain("the server may no longer recognize it");
        const retry = (page: Page) =>
          alert(page).getByRole("button", { name: "Try again", exact: true });
        // Wait for any check the page started itself, so only the click below can start one.
        const enabled = yield* browser.use("Find the retry", (page) =>
          retry(page)
            .waitFor()
            .then(() => retry(page).isEnabled()),
        );
        expect(enabled).toBe(true);
        yield* browser.checkpoint("Lost-session-tools-error");
        const before = server.initializations.lost;
        yield* browser.use("Retry the listing", (page) => retry(page).click());
        // The retry evaluated the app again, opening a new session with the server.
        yield* Effect.suspend(() =>
          server.initializations.lost > before
            ? Effect.void
            : Effect.fail(new Error("The retry did not initialize a new MCP session")),
        ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));
        yield* browser.use("Read the error after the retry", (page) => retry(page).waitFor());

        // Every failure reports, whatever its copy says: every MCP server and skill source
        // answer, refusal and timeout, invalid settings, an unread git response, an MCP client
        // failure without the server's answer, an MCP or skill request no server answered,
        // Executor's network refusing an MCP or skill request, a skill answer the app's own fetch
        // made up or put in place of a failed request, and the error an app's code threw. An agent's
        // MCP `execute` or `skills` call answers with the failure and reports it like REST does.
        const garbled = yield* failing(`${prefix}/apps/${unreadable.id}/skill-bundle`);
        expect(garbled.error.message).toBe(
          "GitHub returned a git response Executor could not read.",
        );
        const unattributed = yield* failing(`${prefix}/apps/${unsupportedApp.id}/tools`);
        expect(unattributed.error.message).toBe(
          "The request to the app’s MCP server failed while connecting.",
        );
        const unreached = yield* failing(`${prefix}/apps/${unanswered.id}/tools`);
        expect(unreached.error.message).toBe(
          "Executor’s request to the app’s MCP server failed before the server answered, while connecting.",
        );
        const refusedEgress = yield* failing(`${prefix}/apps/${egress.id}/tools`);
        expect(refusedEgress.error.message).toContain("NetworkRefused (credential_app)");
        const thrown = yield* failing(`${prefix}/apps/${throwing.id}/tools`);
        expect(thrown.error.message).toBe(
          "Executor could not load this app’s tool definitions. The app threw TypeError: Synthetic failure in the factory",
        );
        const closed = yield* failing(`${prefix}/apps/${closedSkills.id}/skill-bundle`);
        expect(closed.error.message).toBe("Could not reach 127.0.0.1 to load skills.");
        const refusedSkill = yield* failing(`${prefix}/apps/${refusedSkills.id}/skill-bundle`);
        expect(refusedSkill.error.message).toContain("NetworkRefused (credential_app)");
        // A 404 the app's fetch returned, made up or in place of a failed request, reads the same as
        // GitHub's: the copy never claims the repository is missing, and every one reports.
        const madeUpAnswer = yield* failing(`${prefix}/apps/${madeUp.id}/skill-bundle`);
        expect(madeUpAnswer.error.message).toBe(absentCopy);
        const replacedFailure = yield* failing(`${prefix}/apps/${replaced.id}/skill-bundle`);
        expect(replacedFailure.error.message).toBe(absentCopy);
        // The app's caller still reads the error the app threw.
        const thrownMcp = yield* failing(`${prefix}/apps/${forged.id}/tools`);
        expect(thrownMcp.error.message).toBe(lost.error.message);
        const reported = [
          { label: "lost MCP session over REST", trace: lost.trace },
          { label: "stateless MCP refusal over REST", trace: stateless.trace },
          { label: "silent MCP server over REST", trace: silent.trace },
          { label: "missing skill repository over REST", trace: absent.trace },
          { label: "invalid skill source settings over REST", trace: refused.trace },
          { label: "unreadable skill source", trace: garbled.trace },
          { label: "MCP client failure", trace: unattributed.trace },
          { label: "unanswered MCP server", trace: unreached.trace, unsent: true },
          { label: "refused MCP egress", trace: refusedEgress.trace },
          { label: "thrown factory error", trace: thrown.trace },
          { label: "unanswered skill source", trace: closed.trace, unsent: true },
          { label: "refused skill egress", trace: refusedSkill.trace },
          { label: "skill 404 the app's fetch made up", trace: madeUpAnswer.trace },
          {
            label: "skill failure the app's fetch replaced",
            trace: replacedFailure.trace,
            unsent: true,
          },
          { label: "MCP error the app threw", trace: thrownMcp.trace },
          { label: "lost MCP session over MCP execute", trace: mcpTrace },
          { label: "missing skill repository over MCP skills", trace: skillsTrace },
          { label: "app searched after an MCP execute resumed", trace: resumedTrace },
          { label: "MCP execute parked before the search", trace: parkedTrace, none: true },
        ];
        // Cloud also reports a request Executor's network could not send as its own egress failure,
        // on the same trace and before the app hears back.
        const expectedTypes = ({
          unsent,
          none,
        }: {
          readonly unsent?: boolean;
          readonly none?: boolean;
        }) =>
          none === true
            ? []
            : unsent === true
              ? ["AppEgressFailed", "AppEvaluationFailed"]
              : ["AppEvaluationFailed"];
        // These reports arrive after every checked request finished. A missing one fails below,
        // naming the request.
        const events = cloud
          ? yield* awaitSentryEvents((events) =>
              reported.every(
                (entry) =>
                  traceExceptionTypes(events, entry.trace).length >= expectedTypes(entry).length,
              ),
            ).pipe(Effect.catchTag("TimeoutError", () => sentryEvents))
          : [];
        yield* evidence.json("app-evaluation-reporting.json", {
          lost: lost.error,
          stateless: stateless.error,
          absent: absent.error,
          refused: refused.error,
          silent: silent.error,
          unreached: unreached.error,
          refusedEgress: refusedEgress.error,
          garbled: garbled.error,
          unattributed: unattributed.error,
          thrown: thrown.error,
          closed: closed.error,
          refusedSkill: refusedSkill.error,
          madeUp: madeUpAnswer.error,
          replaced: replacedFailure.error,
          thrownMcp: thrownMcp.error,
          agent: { execute: agentReason, skills: agentSkills, resumed: resumedResult },
          ...(cloud
            ? {
                reported: Object.fromEntries(
                  reported.map(({ label, trace }) => [label, traceExceptionTypes(events, trace)]),
                ),
              }
            : {}),
        });
        if (!cloud) return;
        for (const entry of reported)
          expect(traceExceptionTypes(events, entry.trace), entry.label).toEqual(
            expectedTypes(entry),
          );
        expect(JSON.stringify(events)).not.toContain(Redacted.value(issued.key));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
