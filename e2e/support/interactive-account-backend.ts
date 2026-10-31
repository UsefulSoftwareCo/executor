/** A tiny credential custodian, reached by the fixture app over real HTTP. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Deferred, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

export const interactiveBackendKey = "synthetic-backend-key";
const Input = Schema.Struct({
  step: Schema.Literals(["start", "status", "submit", "cancel", "remove"]),
  method: Schema.String,
  caller: Schema.String,
  session: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
});
type Input = typeof Input.Type;
interface Session {
  readonly method: string;
  readonly caller: string;
  readonly ref: string;
  readonly polls: number;
}

export const interactiveAccountBackend = Effect.gen(function* () {
  const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
  const calls = yield* Ref.make<readonly Input[]>([]);
  const next = yield* Ref.make(0);
  const refuseRemoval = yield* Ref.make(false);
  const refuseCancellation = yield* Ref.make(false);
  const removeRemaining = yield* Ref.make<number | undefined>(undefined);
  const removalGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const removalStarted = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const submitGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const submitStarted = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const statusGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const statusStarted = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const routes = HttpRouter.add(
    "POST",
    "/connect",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== `Bearer ${interactiveBackendKey}`)
        return yield* HttpServerResponse.json({ error: "unauthorized" }, { status: 401 });
      const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Input)));
      yield* Ref.update(calls, (calls) => [...calls, input]);
      if (input.caller === "") return HttpServerResponse.empty({ status: 403 });
      if (input.step === "start") {
        const id = yield* Ref.updateAndGet(next, (value) => value + 1);
        const session = `private-session-${id}`;
        yield* Ref.update(sessions, (current) =>
          new Map(current).set(session, {
            method: input.method,
            caller: input.caller,
            ref: `opaque-${id}`,
            polls: 0,
          }),
        );
        return yield* HttpServerResponse.json({
          session,
          url: `http://${request.headers.host}/authorize`,
          ...(input.method === "paste"
            ? { paste: { label: "Paste the final address", placeholder: "http://localhost/..." } }
            : { code: `CODE-${id}` }),
          expiresAt: (yield* Clock.currentTimeMillis) + (input.method === "expired" ? -1 : 60_000),
          message: "Finish signing in, then return here.",
        });
      }
      if (input.step === "remove") {
        const gate = yield* Ref.get(removalGate);
        const started = yield* Ref.get(removalStarted);
        if (started !== undefined) yield* Deferred.succeed(started, undefined);
        if (gate !== undefined) yield* Deferred.await(gate);
        const remaining = yield* Ref.get(removeRemaining);
        if ((yield* Ref.get(refuseRemoval)) || remaining === 0)
          return HttpServerResponse.empty({ status: 503 });
        if (remaining !== undefined) yield* Ref.set(removeRemaining, remaining - 1);
        yield* Ref.update(
          sessions,
          (current) => new Map([...current].filter(([, value]) => value.ref !== input.ref)),
        );
        return yield* HttpServerResponse.json(null);
      }
      const session = (yield* Ref.get(sessions)).get(input.session ?? "");
      if (
        session === undefined ||
        session.method !== input.method ||
        session.caller !== input.caller
      )
        return HttpServerResponse.empty({ status: 409 });
      if (input.step === "cancel") {
        if (yield* Ref.get(refuseCancellation)) return HttpServerResponse.empty({ status: 503 });
        yield* Ref.update(
          sessions,
          (current) => new Map([...current].filter(([id]) => id !== input.session)),
        );
        return yield* HttpServerResponse.json(null);
      }
      if (input.step === "status") {
        const gate = yield* Ref.get(statusGate);
        const started = yield* Ref.get(statusStarted);
        if (started !== undefined) yield* Deferred.succeed(started, undefined);
        if (gate !== undefined) yield* Deferred.await(gate);
      }
      if (input.step === "submit") {
        const gate = yield* Ref.get(submitGate),
          started = yield* Ref.get(submitStarted);
        if (started !== undefined) yield* Deferred.succeed(started, undefined);
        if (gate !== undefined) yield* Deferred.await(gate);
      }
      if (input.method === "slow") return yield* Effect.never;
      if (input.method === "failure")
        return yield* HttpServerResponse.json({ state: "failed", message: "Synthetic refusal" });
      if (input.step === "submit")
        return yield* HttpServerResponse.json(
          input.value === "http://localhost:48765/done?code=synthetic"
            ? {
                state: "connected",
                ref: session.ref,
                accountInfo: { displayName: "Synthetic pasted account" },
              }
            : { state: "failed", message: "Synthetic paste refused" },
        );
      const polls = session.polls + 1;
      yield* Ref.update(sessions, (current) =>
        new Map(current).set(input.session ?? "", { ...session, polls }),
      );
      return yield* HttpServerResponse.json(
        polls < 2
          ? { state: "waiting" }
          : {
              state: "connected",
              ref: session.ref,
              accountInfo: { displayName: "Synthetic device account" },
            },
      );
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    calls: Ref.get(calls),
    refuseCancellation: (refuse: boolean) => Ref.set(refuseCancellation, refuse),
    refuseRemoval: (refuse: boolean) =>
      Ref.set(refuseRemoval, refuse).pipe(Effect.andThen(Ref.set(removeRemaining, undefined))),
    refuseAfter: (successful: number) => Ref.set(removeRemaining, successful),
    holdRemoval: Effect.gen(function* () {
      const gate = yield* Deferred.make<void>(),
        started = yield* Deferred.make<void>();
      yield* Ref.set(removalGate, gate);
      yield* Ref.set(removalStarted, started);
      return {
        started: Deferred.await(started),
        release: Deferred.succeed(gate, undefined).pipe(
          Effect.andThen(Ref.set(removalGate, undefined)),
        ),
      };
    }),
    holdSubmit: Effect.gen(function* () {
      const gate = yield* Deferred.make<void>(),
        started = yield* Deferred.make<void>();
      yield* Ref.set(submitGate, gate);
      yield* Ref.set(submitStarted, started);
      return {
        started: Deferred.await(started),
        release: Deferred.succeed(gate, undefined).pipe(
          Effect.andThen(Ref.set(submitGate, undefined)),
        ),
      };
    }),
    holdStatus: Effect.gen(function* () {
      const gate = yield* Deferred.make<void>(),
        started = yield* Deferred.make<void>();
      yield* Ref.set(statusGate, gate);
      yield* Ref.set(statusStarted, started);
      return {
        started: Deferred.await(started),
        release: Deferred.succeed(gate, undefined).pipe(
          Effect.andThen(Ref.set(statusGate, undefined)),
        ),
      };
    }),
  };
});

/** The app holds backend access through its own linked account, never a global test credential. */
export const interactiveAccountSource = (
  origin: string,
  plain = false,
  withWorkflow = false,
  callbackUrl?: string,
  oauthOrigin?: string,
) => `import {
  defineApp, defineProvider, interactive, secrets, object, string, query, router, bearer, header,
  ${withWorkflow ? "mutation, workflow, appInterval, type MutationContext, type WorkflowContext," : ""}
  type ConnectContext, type QueryContext, type InteractiveStart, type InteractiveStatus
  ${oauthOrigin === undefined ? "" : ", oauth2"}
} from "apps";
const backend = defineProvider({ name: "Credential backend", hosts: ${JSON.stringify([new URL(origin).host, ...(callbackUrl === undefined ? [] : [new URL(callbackUrl).host])])},
  auth: { key: secrets({ label: "Key", fields: object({ token: string()${callbackUrl === undefined ? "" : ", cookie: string()"} }), request: ${callbackUrl === undefined ? "({ token }) => bearer(token)" : "({ token, cookie }) => [bearer(token), header('cookie', cookie)]"} }) } });
const acquired = defineProvider({ name: "Interactive account", hosts: [${JSON.stringify(new URL(origin).host)}], auth: {
  device: interactive({ label: "Device code" }), paste: interactive({ label: "Paste address" }),
  expired: interactive({ label: "Expired" }), failure: interactive({ label: "Failure" }), slow: interactive({ label: "Slow" }),
  ${oauthOrigin === undefined ? "" : `manual: secrets({ label: "Manual", fields: object({ token: string() }) }), browser: oauth2({ discover: ${JSON.stringify(oauthOrigin + "/mcp")} }),`}
} });
const requirements = { app: { accounts: { backend, sharedIdentity: acquired.many() } }, user: { accounts: { identity: acquired${plain ? "" : ".many()"} } } };
async function call<T>(ctx: ConnectContext<typeof requirements>, step: string, input: object): Promise<T> {
  const backend = ctx.app.accounts.backend;
  if (backend === undefined) throw new Error("Connect the backend account first");
  const response = await ctx.fetch(${JSON.stringify(`${origin}/connect`)}, {
    method: "POST", signal: ctx.signal, headers: { ...backend.headers(), "content-type": "application/json" },
    body: JSON.stringify({ step, ...input, caller: ctx.user.id ?? "" }),
  });
  if (!response.ok) throw new Error("The backend refused this step");
  return await response.json() as T;
}
const handlers = {
  start: async (ctx: ConnectContext<typeof requirements>, input: { method: string }) => call<InteractiveStart>(ctx, "start", input),
  status: async (ctx: ConnectContext<typeof requirements>, input: { method: string; session: string }) => call<InteractiveStatus>(ctx, "status", input),
  submit: async (ctx: ConnectContext<typeof requirements>, input: { method: string; session: string; value: string }) => call<InteractiveStatus>(ctx, "submit", input),
  cancel: async (ctx: ConnectContext<typeof requirements>, input: { method: string; session: string }) => { await call(ctx, "cancel", input); },
  remove: async (ctx: ConnectContext<typeof requirements>, input: { method: string; ref: string }) => {
    ${
      callbackUrl === undefined
        ? ""
        : `const backend = ctx.app.accounts.backend;
    if (backend === undefined) throw new Error("Connect the backend first");
    const response = await ctx.fetch(${JSON.stringify(callbackUrl)}, { signal: ctx.signal, headers: { cookie: backend.fields.cookie } });
    if (!response.ok) throw new Error("The authenticated server callback failed");`
    }
    await call(ctx, "remove", input);
  },
};
const refs = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  caller: ctx.user.id,
  accounts: [...${plain ? "[ctx.user.accounts.identity]" : "ctx.user.accounts.identity"}, ...ctx.app.accounts.sharedIdentity].map((account) => ({
    id: account.id, method: account.method, fields: account.fields, keys: Object.keys(account.fields),
  })),
}));
${
  withWorkflow
    ? `const tick = mutation({ input: object({}) }, async (ctx: MutationContext<typeof requirements, "app">) => {
  await ctx.workflows.start({ workflow: "hold", input: {} });
  return null;
});
const hold = workflow({ input: object({}) }, async (ctx: WorkflowContext<typeof requirements, "app">) => {
  await ctx.step.sleep("hold", "1 minute");
  return null;
});`
    : ""
}
export default defineApp(requirements, { tools: router({ refs${withWorkflow ? ", tick" : ""} }),
  ${withWorkflow ? "workflows: { hold }, schedules: { tick: appInterval({ minutes: 1 }, tick, {}) }," : ""}
  connect: { identity: handlers, sharedIdentity: handlers } });`;
