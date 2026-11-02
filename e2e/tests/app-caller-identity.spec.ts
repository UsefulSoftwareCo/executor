/** A shared app's handlers and cached dynamic declarations stay bound to the calling user. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { appLinksFixture } from "../support/app-links.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Resource } from "../support/contracts.ts";
import { WorkflowRun } from "../support/workflow-app.ts";
import { Browser } from "../support/browser.ts";

const source = `import {
  defineApp, dynamicRouter, mutation, object, query, router, string, workflow
} from "apps";
import { createAppHandler, hostContext } from "apps/host";
const portable = createAppHandler(defineApp({}, {
  tools: router({ who: query({ input: object({}) }, async (ctx) => ({
    hasUser: "user" in ctx, id: ctx.user?.id ?? null,
  })) }),
}));
const direct = query({ input: object({}) }, async (ctx) => {
  const invoke = async (accounts, caller) => {
    const response = await portable(new Request("https://app.invalid", {
      method: "POST", body: JSON.stringify({ operation: "call", tool: "who", input: {} }),
    }), hostContext(accounts, undefined, caller));
    return { status: response.status, body: await response.json() };
  };
  return {
    caller: await invoke({ app: {} }, ctx.user.id),
    app: await invoke({ app: {} }, undefined),
    subjectless: await invoke({ app: {}, user: {} }, undefined),
  };
});
const who = query({ input: object({}) }, async (ctx) => ctx.user.id ?? "missing");
const spoof = mutation({ input: object({ userId: string() }) }, async (ctx, input) => ({
  callerId: ctx.user.id ?? "missing",
  suppliedId: input.userId,
}));
const record = workflow({ input: object({}) }, async (ctx) =>
  ctx.step.do("caller", async (step) => step.user.id ?? "missing"));
const launch = mutation({ input: object({}) }, async (ctx) =>
  ctx.workflows.start({ workflow: "record", input: {} }));
export default defineApp({}, async (ctx) => {
  const id = ctx.user?.id ?? "missing";
  const name = "caller_" + id;
  const fromFactory = query({ input: object({}) }, async () => id);
  const generated = dynamicRouter({
    list: async () => [{
      name,
      description: "Caller " + id,
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    }],
    resolve: async (requested) => requested === name ? fromFactory : undefined,
  });
  return { tools: router({ who, direct, spoof, generated, launch }), workflows: { record } };
});`;

const SessionIdentity = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
);
const ToolIndex = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
const ToolList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) }),
  ),
});
const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
const SpoofResult = Schema.Struct({ callerId: Schema.String, suppliedId: Schema.String });
const Token = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.String }),
});

layer(HostedLive, { excludeTestServices: true })("App caller identity", (it) => {
  it.effect(scenarios.appCallerIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          mcp = yield* McpClient,
          browser = yield* Browser;
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { actors, path } = fixture;

        const userId = (actor: Session) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "GET", "/api/auth/get-session");
            expect(response.status).toBe(200);
            const session = yield* body(SessionIdentity, response);
            if (session === null) throw new Error("The authenticated session has no user.");
            return session.user.id;
          });
        const [ownerId, memberId] = yield* Effect.all(
          [userId(actors.owner), userId(actors.member)],
          { concurrency: 2 },
        );
        expect(ownerId).not.toBe(memberId);

        const generatedName = (id: string) => `generated.caller_${id}`;
        const index = (actor: Session) =>
          api.request(actor, "GET", `${path}/tools/index`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(ToolIndex, response)),
          );
        const list = (actor: Session) =>
          api.request(actor, "GET", `${path}/tools`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(ToolList, response)),
          );
        const get = (actor: Session, name: string) =>
          api.request(actor, "GET", `${path}/tools/${encodeURIComponent(name)}`).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.flatMap((response) => body(Tool, response)),
          );
        const call = (actor: Session, tool: string, kind: "query" | "mutation", input: object) =>
          api.request(actor, "POST", `${path}/tools/call`, { tool, kind, input });

        // Both users have the same empty account set when these routes read the declaration cache.
        const ownerIndex = yield* index(actors.owner);
        expect(ownerIndex.items.map((tool) => tool.name)).toContain(generatedName(ownerId));
        const memberIndex = yield* index(actors.member);
        expect(memberIndex.items.map((tool) => tool.name)).toContain(generatedName(memberId));
        expect(memberIndex.items.map((tool) => tool.name)).not.toContain(generatedName(ownerId));

        const ownerList = yield* list(actors.owner);
        const ownerListedTool = ownerList.items.find(
          (tool) => tool.name === generatedName(ownerId),
        );
        expect(ownerListedTool?.description).toBe(`Caller ${ownerId}`);
        const memberList = yield* list(actors.member);
        const memberListedTool = memberList.items.find(
          (tool) => tool.name === generatedName(memberId),
        );
        expect(memberListedTool?.description).toBe(`Caller ${memberId}`);
        expect(memberList.items.some((tool) => tool.name === generatedName(ownerId))).toBe(false);

        expect(yield* get(actors.owner, generatedName(ownerId))).toMatchObject({
          name: generatedName(ownerId),
          description: `Caller ${ownerId}`,
        });
        expect(yield* get(actors.member, generatedName(memberId))).toMatchObject({
          name: generatedName(memberId),
          description: `Caller ${memberId}`,
        });

        const query = (actor: Session) =>
          Effect.gen(function* () {
            const response = yield* call(actor, "who", "query", {});
            expect(response.status).toBe(200);
            return yield* body(Schema.String, response);
          });
        expect(yield* query(actors.owner)).toBe(ownerId);
        expect(yield* query(actors.member)).toBe(memberId);
        expect(yield* query(actors.owner)).toBe(ownerId);

        // Portable hosts can supply a caller without any user-account requirements.
        const direct = yield* call(actors.member, "direct", "query", {});
        expect(direct.status).toBe(200);
        expect(direct.body).toEqual({
          caller: { status: 200, body: { ok: true, value: { hasUser: true, id: memberId } } },
          app: { status: 200, body: { ok: true, value: { hasUser: false, id: null } } },
          subjectless: { status: 200, body: { ok: true, value: { hasUser: true, id: null } } },
        });

        // Subscription queries execute lazily, after the HTTP handler's auth scope has ended.
        const subscribe = (actor: Session) =>
          Effect.gen(function* () {
            yield* browser.login(actor);
            yield* browser.use("Open the authenticated app dashboard", (page) =>
              page.goto(`/org/${actors.organization.slug}/apps/${fixture.app.id}`),
            );
            const event = yield* browser.use(
              "Read the caller's first subscription snapshot",
              (page) =>
                page.evaluate(
                  (path) =>
                    fetch(`${path}/data/subscribe`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ name: "who", input: {} }),
                    }).then((response) => {
                      if (!response.ok || response.body === null)
                        throw new Error(`Subscription HTTP ${response.status}`);
                      const reader = response.body.getReader(),
                        decoder = new TextDecoder();
                      let text = "";
                      const next = (): Promise<string> =>
                        reader.read().then((chunk) => {
                          if (chunk.done) throw new Error("Subscription ended without a snapshot");
                          text += decoder.decode(chunk.value, { stream: true });
                          const lines = text.split("\n");
                          const data = lines.slice(0, -1).find((line) => line.startsWith("data: "));
                          return data === undefined ? next() : data.slice(6);
                        });
                      return next().finally(() => reader.cancel());
                    }),
                  path,
                ),
            );
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  value: Schema.String,
                  revision: Schema.Number,
                }),
              ),
            )(event);
          });
        expect((yield* subscribe(actors.owner)).value).toBe(ownerId);
        expect((yield* subscribe(actors.member)).value).toBe(memberId);

        const ownerSpoof = yield* call(actors.owner, "spoof", "mutation", { userId: memberId });
        expect(ownerSpoof.status).toBe(200);
        expect(yield* body(SpoofResult, ownerSpoof)).toEqual({
          callerId: ownerId,
          suppliedId: memberId,
        });
        const memberSpoof = yield* call(actors.member, "spoof", "mutation", { userId: ownerId });
        expect(memberSpoof.status).toBe(200);
        expect(yield* body(SpoofResult, memberSpoof)).toEqual({
          callerId: memberId,
          suppliedId: ownerId,
        });

        const ownerFactoryCall = yield* call(actors.owner, generatedName(ownerId), "query", {});
        expect(ownerFactoryCall.status).toBe(200);
        expect(yield* body(Schema.String, ownerFactoryCall)).toBe(ownerId);
        const memberFactoryCall = yield* call(actors.member, generatedName(memberId), "query", {});
        expect(memberFactoryCall.status).toBe(200);
        expect(yield* body(Schema.String, memberFactoryCall)).toBe(memberId);

        // Steps refresh accounts while keeping the member that started the run.
        const workflowCaller = (actor: Session) =>
          Effect.gen(function* () {
            const launched = yield* call(actor, "launch", "mutation", {});
            expect(launched.status).toBe(200);
            const run = yield* body(Resource, launched);
            const deadline = (yield* Clock.currentTimeMillis) + 15000;
            for (;;) {
              const response = yield* api.request(actor, "GET", `${path}/workflow-runs/${run.id}`);
              expect(response.status).toBe(200);
              const current = yield* body(WorkflowRun, response);
              if (current.status === "complete") return current.output;
              expect(current.status, JSON.stringify(current)).not.toBe("errored");
              expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        expect(yield* workflowCaller(actors.owner)).toBe(ownerId);
        expect(yield* workflowCaller(actors.member)).toBe(memberId);

        const issued = yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
          name: "Caller identity fixture",
        });
        expect(issued.status).toBe(200);
        const token = yield* body(Token, issued);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "POST", "/api/auth/api-key/delete", {
              keyId: token.id,
            })
            .pipe(Effect.asVoid, Effect.orDie),
        );
        const client = yield* mcp.connect(token.key, "caller identity", {
          organization: actors.organization.id,
        });
        const result = yield* client.use("MCP caller identity", (client, signal) =>
          client.callTool(
            {
              name: "execute",
              arguments: {
                code: `return await tools[${JSON.stringify(fixture.app.slug)}].who({});`,
              },
            },
            undefined,
            { signal },
          ),
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent)).execution.value,
        ).toBe(memberId);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
