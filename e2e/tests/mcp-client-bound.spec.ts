/**
 * Self-host keeps protocol state for a bounded number of MCP clients, one per API key or OAuth grant
 * (`EXECUTOR_MCP_CLIENTS`), and for at most `EXECUTOR_MCP_CLIENTS_PER_USER` of one member's. These
 * scenarios run with a bound of three clients and two per member. Past the bound the least recently
 * used client that owns no work is forgotten to admit the new one, and the forgotten client's
 * session is told to initialize again. A client with a request in flight, such as a call whose
 * approval prompt waits for its client, or with a paused program, is never forgotten; when no
 * client may be, the new one is refused with `503` and `Retry-After: 1`. Before, a full list
 * refused every new client while its 30-minute idle entries stayed.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

type Role = "owner" | "admin" | "member";
interface Key {
  readonly key: Redacted.Redacted<string>;
  readonly credentials: Readonly<Record<string, string>>;
}

const Reply = Schema.Struct({
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});

/** An API key of `role`, a client of its own, removed when the scenario ends. */
const apiKey = (role: Role, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const created = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors[role], "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors[role], "POST", "/api/auth/api-key/delete", { keyId: created.id })
        .pipe(Effect.orDie),
    );
    const key: Key = {
      key: created.key,
      credentials: {
        authorization: `Bearer ${Redacted.value(created.key)}`,
        "x-executor-organization": actors.organization.id,
      },
    };
    return key;
  });

/** One JSON-RPC POST to /mcp: its status, `Retry-After`, session and reply. */
const post = (key: Key, message: object, session?: string) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(new URL("/mcp", target.metadata.origin), {
      headers: {
        ...key.credentials,
        accept: "application/json, text/event-stream",
        ...(session === undefined
          ? {}
          : { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" }),
      },
    }).pipe(HttpClientRequest.bodyJson({ jsonrpc: "2.0", ...message }));
    const response = yield* http.execute(request).pipe(Effect.timeout("30 seconds"));
    const text = yield* response.text;
    return {
      status: response.status,
      retryAfter: response.headers["retry-after"],
      session: response.headers["mcp-session-id"],
      text,
    };
  }).pipe(Effect.scoped, Effect.provideService(HttpClient.TracerPropagationEnabled, false));

const initialize = (key: Key) =>
  post(key, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "executor-e2e-client-bound", version: "1" },
    },
  });
/** A session of the key's client, opened and confirmed. */
const open = (key: Key) =>
  Effect.gen(function* () {
    const opened = yield* initialize(key);
    expect(opened.status, opened.text).toBe(200);
    const session = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(opened.session);
    expect((yield* post(key, { method: "notifications/initialized" }, session)).status).toBe(202);
    return session;
  });
/** The status a ping in the session answers: 200 while its client is kept, 404 once forgotten. */
const ping = (key: Key, session: string) =>
  post(key, { id: 2, method: "ping" }, session).pipe(Effect.map(({ status }) => status));

const checkIdleForgotten = Effect.gen(function* () {
  const evidence = yield* Evidence;
  const owner = yield* apiKey("owner", "Client bound owner");
  const admin = yield* apiKey("admin", "Client bound admin");
  const member = yield* apiKey("member", "Client bound member");
  const later = yield* apiKey("member", "Client bound member, later");
  const owners = yield* open(owner);
  const admins = yield* open(admin);
  const members = yield* open(member);
  // The owner's client is used again, so the admin's is now the least recently used.
  expect(yield* ping(owner, owners)).toBe(200);
  yield* evidence.step(
    "With three idle clients kept, a fourth is admitted",
    Effect.gen(function* () {
      const latest = yield* open(later);
      expect(yield* ping(later, latest), "the new client").toBe(200);
    }),
  );
  yield* evidence.step(
    "Only the least recently used client was forgotten, and its session is told to initialize again",
    Effect.gen(function* () {
      expect(yield* ping(owner, owners), "the owner's client, used since").toBe(200);
      expect(yield* ping(member, members), "the member's first client").toBe(200);
      expect(yield* ping(admin, admins), "the admin's client, least recently used").toBe(404);
      const again = yield* open(admin);
      expect(yield* ping(admin, again)).toBe(200);
    }),
  );
});

const checkPerUser = Effect.gen(function* () {
  const evidence = yield* Evidence;
  const owner = yield* apiKey("owner", "Client share owner");
  const members = yield* Effect.forEach([1, 2, 3], (n) => apiKey("member", `Client share ${n}`));
  const owners = yield* open(owner);
  const first = yield* open(members[0]!);
  const second = yield* open(members[1]!);
  yield* evidence.step(
    "A member's third client is admitted by forgetting that member's own oldest, not the oldest overall",
    Effect.gen(function* () {
      const third = yield* open(members[2]!);
      expect(yield* ping(members[2]!, third)).toBe(200);
      expect(yield* ping(members[1]!, second)).toBe(200);
      expect(yield* ping(owner, owners), "the owner's client, the oldest of all").toBe(200);
      expect(yield* ping(members[0]!, first), "the member's own oldest client").toBe(404);
    }),
  );
});

/** An app whose `approved` tool always asks for approval, removed when the scenario ends. */
const deployApprovalApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const root = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${root}/apps/deploy`, {
    name: "Clients owning work",
    files: [
      {
        path: "index.ts",
        content: `import { defineApp, mutation, object, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, { tools: router({
  approved: mutation({ input: object({}), approval: always() }, async () => "approved"),
}) });`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${root}/apps/${app.id}`).pipe(Effect.orDie),
  );
  return app;
});

const checkOwningWork = Effect.gen(function* () {
  const actors = yield* Actors,
    evidence = yield* Evidence,
    mcp = yield* McpClient;
  const organization = actors.organization.id;
  const app = yield* deployApprovalApp;
  const approve = `return await tools[${JSON.stringify(app.slug)}].approved({})`;
  const prompted = yield* apiKey("owner", "Client with a prompt");
  const paused = yield* apiKey("owner", "Client with a paused program");
  const another = yield* apiKey("owner", "Owner's third client");
  const admins = yield* Effect.forEach([1, 2], (n) => apiKey("admin", `Admin client ${n}`));
  const services = yield* Effect.context<HttpClient.HttpClient | Target | Evidence>();
  const forgotten: Array<string> = [];
  let duringPrompt: Exit.Exit<void, unknown> = Exit.void;

  const model = yield* mcp.connect(paused.key, "paused-program", { organization, mode: "model" });
  // Runs while the prompted client's call waits for its answer, its event stream open.
  const whilePrompted = Effect.gen(function* () {
    const pending = yield* model
      .use("Start a program that pauses for approval", (client, signal) =>
        client.callTool({ name: "execute", arguments: { code: approve } }, undefined, { signal }),
      )
      .pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Pending)(result.structuredContent)),
      );
    yield* evidence.step(
      "The owner holds two clients that own work, so a third of theirs is refused",
      Effect.gen(function* () {
        const refused = yield* initialize(another);
        expect(refused.status, refused.text).toBe(503);
        expect(refused.retryAfter).toBe("1");
        const reply = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))(refused.text);
        expect(reply.error?.code).toBe(-32013);
      }),
    );
    yield* evidence.step(
      "Other members' clients are admitted past the bound without forgetting either",
      Effect.gen(function* () {
        // The second fills the third place; the next is admitted by forgetting it.
        forgotten.push(yield* open(admins[0]!));
        const kept = yield* open(admins[1]!);
        expect(yield* ping(admins[1]!, kept)).toBe(200);
      }),
    );
    yield* evidence.step(
      "The paused program resumes through its own client",
      Effect.gen(function* () {
        const resumed = yield* model.use("Approve the paused program", (client, signal) =>
          client.callTool(
            {
              name: "resume",
              arguments: { requestId: pending.requestId, response: { action: "accept" } },
            },
            undefined,
            { signal },
          ),
        );
        const completed = yield* Schema.decodeUnknownEffect(Completed)(resumed.structuredContent);
        expect(completed.execution.value).toBe("approved");
      }),
    );
  }).pipe(Effect.provideContext(services));

  const native = yield* mcp.connect(prompted.key, "prompted-call", {
    organization,
    mode: "native",
    // The MCP SDK turns a failed approval hook into a declined prompt, so its failure is kept here.
    whileApproving: whilePrompted.pipe(
      Effect.exit,
      Effect.map((exit) => {
        duringPrompt = exit;
      }),
    ),
  });
  const answered = yield* native.use("Call a tool whose approval prompt waits", (client, signal) =>
    client.callTool({ name: "execute", arguments: { code: approve } }, undefined, {
      signal,
      timeout: 60_000,
    }),
  );
  if (Exit.isFailure(duringPrompt)) return yield* Effect.failCause(duringPrompt.cause);
  yield* evidence.step(
    "The call whose prompt waited completes, and the idle client admitted for it was forgotten",
    Effect.gen(function* () {
      expect(yield* native.elicitationCount).toBe(1);
      const completed = yield* Schema.decodeUnknownEffect(Completed)(answered.structuredContent);
      expect(completed.execution.value).toBe("approved");
      expect(yield* ping(admins[0]!, forgotten[0]!)).toBe(404);
    }),
  );
});

layer(HostedLive, { excludeTestServices: true })("Self-host MCP client bound", (it) => {
  it.effect(scenarios.mcpClientsIdleForgotten.title, (context) =>
    withHostedCase(context, checkIdleForgotten),
  );
  it.effect(scenarios.mcpClientsPerUser.title, (context) => withHostedCase(context, checkPerUser));
  it.effect(scenarios.mcpClientsOwningWork.title, (context) =>
    withHostedCase(context, checkOwningWork.pipe(Effect.provide(McpClient.layer))),
  );
});
