/** A tiny credential custodian, reached by the fixture app over real HTTP. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Deferred, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

export const interactiveBackendKey = "synthetic-backend-key";
export const interactiveBackendNextKey = "synthetic-backend-next-key";
const Input = Schema.Struct({
  step: Schema.Literals(["start", "status", "submit", "cancel", "remove", "check"]),
  method: Schema.String,
  caller: Schema.String,
  session: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  operation: Schema.optionalKey(Schema.String),
});
type Input = typeof Input.Type;
interface Session {
  readonly method: string;
  readonly caller: string;
  readonly ref: string;
  readonly polls: number;
}
type DriverStep = "check";
interface DriverGate {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
type FixtureAccountInfo = Readonly<Record<string, string>>;
interface StartExposure {
  readonly field: "url" | "code" | "message" | "label" | "placeholder";
  readonly encoded: boolean;
}

export const interactiveAccountBackend = Effect.gen(function* () {
  const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
  const calls = yield* Ref.make<readonly Input[]>([]);
  const next = yield* Ref.make(0);
  const clockOffset = yield* Ref.make(0);
  const driverHealth = yield* Ref.make<Schema.Json>({
    accountInfo: { displayName: "Synthetic driver identity" },
  });
  const driverHealthStatus = yield* Ref.make(200);
  const driverGates = yield* Ref.make<ReadonlyMap<DriverStep, DriverGate>>(new Map());
  const accountInfo = yield* Ref.make<FixtureAccountInfo | undefined>(undefined);
  const acquisitionFailure = yield* Ref.make<string | undefined>(undefined);
  const startExposure = yield* Ref.make<StartExposure | undefined>(undefined);
  const refuseRemoval = yield* Ref.make(false);
  const refuseCancellation = yield* Ref.make(false);
  const removeRemaining = yield* Ref.make<number | undefined>(undefined);
  const loseRemovalResponse = yield* Ref.make(false);
  const removalReceipts = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const removalEffects = yield* Ref.make<readonly Input[]>([]);
  const removeCalls = yield* Ref.make<
    readonly (Input & { readonly credential: string; readonly knownReference: boolean })[]
  >([]);
  const removalGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const removalStarted = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const submitGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const submitStarted = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const nextSubmit = yield* Ref.make<DriverGate | undefined>(undefined);
  const statusGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const statusStarted = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const routes = HttpRouter.add(
    "POST",
    "/connect",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const credential = request.headers.authorization ?? "";
      if (
        ![interactiveBackendKey, interactiveBackendNextKey].some(
          (key) => credential === `Bearer ${key}`,
        )
      )
        return yield* HttpServerResponse.json({ error: "unauthorized" }, { status: 401 });
      const input = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Input)));
      yield* Ref.update(calls, (calls) => [...calls, input]);
      if (input.step === "remove") {
        const knownReference = [...(yield* Ref.get(sessions)).values()].some(
          (session) => session.ref === input.ref,
        );
        yield* Ref.update(removeCalls, (calls) => [
          ...calls,
          { ...input, credential, knownReference },
        ]);
      }
      if (input.caller === "") return HttpServerResponse.empty({ status: 403 });
      if (input.step === "check") {
        const saved = [...(yield* Ref.get(sessions)).values()].find(
          (session) => session.ref === input.ref && session.caller === input.caller,
        );
        if (saved === undefined) return HttpServerResponse.empty({ status: 401 });
        const gate = (yield* Ref.get(driverGates)).get(input.step);
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
        }
        return yield* HttpServerResponse.json(yield* Ref.get(driverHealth), {
          status: yield* Ref.get(driverHealthStatus),
        });
      }
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
        const exposure = yield* Ref.get(startExposure);
        const reference = input.ref ?? "";
        const shown = exposure?.encoded ? Buffer.from(reference).toString("base64") : reference;
        const exposed =
          exposure === undefined || input.ref === undefined
            ? {}
            : exposure.field === "url"
              ? { url: `http://${request.headers.host}/authorize?ref=${shown}` }
              : exposure.field === "label" || exposure.field === "placeholder"
                ? {
                    paste: {
                      label: exposure.field === "label" ? shown : "Paste the final address",
                      ...(exposure.field === "placeholder" ? { placeholder: shown } : {}),
                    },
                  }
                : { [exposure.field]: shown };
        return yield* HttpServerResponse.json({
          session,
          url: `http://${request.headers.host}/authorize`,
          ...(input.method === "paste"
            ? { paste: { label: "Paste the final address", placeholder: "http://localhost/..." } }
            : { code: `CODE-${id}` }),
          expiresAt:
            (yield* Clock.currentTimeMillis) +
            (yield* Ref.get(clockOffset)) +
            (input.method === "expired" ? -1 : 60_000),
          message: "Finish signing in, then return here.",
          ...exposed,
        });
      }
      if (input.step === "remove") {
        const gate = yield* Ref.get(removalGate);
        const started = yield* Ref.get(removalStarted);
        if (started !== undefined) yield* Deferred.succeed(started, undefined);
        if (gate !== undefined) yield* Deferred.await(gate);
        const operation =
          input.operation === undefined
            ? undefined
            : JSON.stringify([input.caller, input.operation]);
        const receipt =
          operation === undefined ? undefined : (yield* Ref.get(removalReceipts)).get(operation);
        if (receipt !== undefined)
          return receipt === input.ref
            ? yield* HttpServerResponse.json(null)
            : HttpServerResponse.empty({ status: 409 });
        const remaining = yield* Ref.get(removeRemaining);
        if ((yield* Ref.get(refuseRemoval)) || remaining === 0)
          return HttpServerResponse.empty({ status: 503 });
        if (remaining !== undefined) yield* Ref.set(removeRemaining, remaining - 1);
        yield* Ref.update(
          sessions,
          (current) => new Map([...current].filter(([, value]) => value.ref !== input.ref)),
        );
        yield* Ref.update(removalEffects, (effects) => [...effects, input]);
        if (operation !== undefined)
          yield* Ref.update(removalReceipts, (receipts) =>
            new Map(receipts).set(operation, input.ref ?? ""),
          );
        if (yield* Ref.getAndSet(loseRemovalResponse, false))
          return HttpServerResponse.empty({ status: 503 });
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
        const next = yield* Ref.getAndSet(nextSubmit, undefined);
        if (next !== undefined) {
          yield* Deferred.succeed(next.started, undefined);
          yield* Deferred.await(next.release);
        }
        const gate = yield* Ref.get(submitGate),
          started = yield* Ref.get(submitStarted);
        if (started !== undefined) yield* Deferred.succeed(started, undefined);
        if (gate !== undefined) yield* Deferred.await(gate);
      }
      if (input.method === "slow") return yield* Effect.never;
      const failure = yield* Ref.get(acquisitionFailure);
      if (failure !== undefined)
        return yield* HttpServerResponse.json({ state: "failed", message: failure });
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
  const holdDriver = (step: DriverStep) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>(),
        gate = yield* Deferred.make<void>();
      yield* Ref.update(driverGates, (current) =>
        new Map(current).set(step, { started, release: gate }),
      );
      const release = Deferred.succeed(gate, undefined).pipe(
        Effect.andThen(
          Ref.update(driverGates, (current) => {
            const next = new Map(current);
            next.delete(step);
            return next;
          }),
        ),
      );
      yield* Effect.addFinalizer(() => release);
      return { started: Deferred.await(started), release };
    });
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    calls: Ref.get(calls),
    removeCalls: Ref.get(removeCalls),
    removalEffects: Ref.get(removalEffects),
    loseNextRemovalResponse: Ref.set(loseRemovalResponse, true),
    advanceClock: (milliseconds: number) =>
      Ref.update(clockOffset, (offset) => offset + milliseconds),
    driverHealth: (value: Schema.Json, status = 200) =>
      Ref.set(driverHealth, value).pipe(Effect.andThen(Ref.set(driverHealthStatus, status))),
    holdCheck: holdDriver("check"),
    setAccountInfo: (value: FixtureAccountInfo) => Ref.set(accountInfo, value),
    failAcquisition: (message?: string) => Ref.set(acquisitionFailure, message),
    exposeStartReference: (value?: StartExposure) => Ref.set(startExposure, value),
    refuseCancellation: (refuse: boolean) => Ref.set(refuseCancellation, refuse),
    refuseRemoval: (refuse: boolean) =>
      Ref.set(refuseRemoval, refuse).pipe(Effect.andThen(Ref.set(removeRemaining, undefined))),
    refuseAfter: (successful: number) => Ref.set(removeRemaining, successful),
    holdRemoval: Effect.gen(function* () {
      const gate = yield* Deferred.make<void>(),
        started = yield* Deferred.make<void>();
      yield* Ref.set(removalGate, gate);
      yield* Ref.set(removalStarted, started);
      const release = Deferred.succeed(gate, undefined).pipe(
        Effect.andThen(Ref.set(removalGate, undefined)),
      );
      yield* Effect.addFinalizer(() => release);
      return {
        started: Deferred.await(started),
        release,
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
    holdNextSubmit: Effect.gen(function* () {
      const started = yield* Deferred.make<void>(),
        gate = yield* Deferred.make<void>();
      yield* Ref.set(nextSubmit, { started, release: gate });
      const release = Deferred.succeed(gate, undefined).pipe(
        Effect.andThen(Ref.set(nextSubmit, undefined)),
      );
      yield* Effect.addFinalizer(() => release);
      return { started: Deferred.await(started), release };
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
