/** Tool-originated forms through the portable framework, including lifetime and schema enforcement. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mutation, defineApp, object, string, type Elicit, type FormElicitation } from "apps";
import { ElicitationFailed, HostResponse, type ElicitationHandler } from "apps/contracts";
import { createAppHandler, createIsolatedAppHandler, hostContext } from "apps/host";
import { TelemetryBatch } from "@executor-js/telemetry";
import { fromPromise, toPromise } from "../src/implementation/authoring.ts";
import { Deferred, Effect, Schema } from "effect";

const form: FormElicitation = {
  mode: "form",
  message: "Choose a name",
  requestedSchema: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
  },
};
const Name = object({ name: string({ minLength: 1 }) });
const call = (
  handler: ReturnType<typeof createAppHandler>,
  elicitation?: ElicitationHandler,
  signal?: AbortSignal,
) =>
  handler(
    new Request("https://test/dispatch", {
      method: "POST",
      body: JSON.stringify({ operation: "call", tool: "mutations.ask", input: {} }),
      ...(signal === undefined ? {} : { signal }),
    }),
    { ...hostContext({}), ...(elicitation === undefined ? {} : { elicitation }) },
  );
const decode = async (response: Response) =>
  Schema.decodeUnknownSync(HostResponse)(await response.json());

function fixture() {
  let starts = 0;
  let finishes = 0;
  let retained: Elicit | undefined;
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async (appContext) => {
      const context = appContext;
      return {
        mutations: {
          ask: mutation(
            { description: "Ask", input: object({}) },
            async (_operationContext, _input) => {
              const marker = ++starts;
              retained = context.elicit;
              const response = await context.elicit(form);
              if (response.action !== "accept") return { marker, action: response.action };
              finishes++;
              return { marker, name: Name.parse(response.content).name };
            },
          ),
        },
      };
    }),
  );
  return { handler, state: () => ({ starts, finishes }), retained: () => retained };
}

test("a running tool retains its local state across a form and its capability closes on return", async () => {
  const f = fixture();
  let delivered = 0;
  let ownerSignal: AbortSignal | undefined;
  const result = await decode(
    await call(f.handler, (request, signal) =>
      Effect.sync(() => {
        assert.deepEqual(f.state(), { starts: 1, finishes: 0 });
        assert.equal(request.message, form.message);
        ownerSignal = signal;
        delivered++;
        return { action: "accept" as const, content: { name: "Ada" } };
      }),
    ),
  );
  assert.deepEqual(result, { ok: true, value: { marker: 1, name: "Ada" } });
  assert.deepEqual(f.state(), { starts: 1, finishes: 1 });
  assert.equal(ownerSignal?.aborted, true);
  const retained = f.retained();
  assert.ok(retained);
  await assert.rejects(() => retained(form));
  assert.equal(delivered, 1);
});

for (const action of ["decline", "cancel"] as const)
  test(`tool code can handle a ${action} response without restarting`, async () => {
    const f = fixture();
    assert.deepEqual(await decode(await call(f.handler, () => Effect.succeed({ action }))), {
      ok: true,
      value: { marker: 1, action },
    });
    assert.deepEqual(f.state(), { starts: 1, finishes: 0 });
  });

test("missing delivery and invalid accepted data fail safely before the tool continues", async () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    const result = await decode(
      await call(
        f.handler,
        invalid ? () => Effect.succeed({ action: "accept", content: { name: 42 } }) : undefined,
      ),
    );
    assert.equal(result.ok, false);
    if (result.ok || !Schema.is(ElicitationFailed)(result.error))
      throw new Error("Expected an elicitation failure");
    assert.equal(result.error.reason, invalid ? "invalid-response" : "unavailable");
    assert.deepEqual(f.state(), { starts: 1, finishes: 0 });
  }
});

test("discovery and app evaluation cannot trigger a user interaction", async () => {
  let prompts = 0;
  const handler = createAppHandler(
    defineApp({ accounts: {} }, async (appContext) => {
      const { elicit } = appContext;
      await elicit(form);
      return {};
    }),
  );
  const response = await handler(
    new Request("https://test/dispatch", {
      method: "POST",
      body: JSON.stringify({ operation: "inspect" }),
    }),
    {
      ...hostContext({}),
      elicitation: () =>
        Effect.sync(() => {
          prompts++;
          return { action: "accept" as const, content: { name: "Ada" } };
        }),
    },
  );
  assert.equal(response.status, 500);
  assert.equal(prompts, 0);
});

test(
  "request cancellation interrupts an outstanding tool interaction",
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const controller = new AbortController();
    const started = Effect.runSync(Deferred.make<void>());
    let aborted = false;
    const result = call(
      f.handler,
      (_request, signal) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              aborted = signal.aborted;
            }),
          ),
        ),
      controller.signal,
    );
    const rejected = assert.rejects(() => result);
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    await rejected;
    assert.equal(aborted, true);
    assert.deepEqual(f.state(), { starts: 1, finishes: 0 });
  },
);

for (const mode of ["promise", "native"] as const) {
  test(`${mode} tool's captured elicitation callback traces its input wait under the executing tool`, async () => {
    const entered = Deferred.makeUnsafe<void>();
    const answer = Deferred.makeUnsafe<import("apps").ElicitationResponse>();
    let finished = false;
    const handler = createIsolatedAppHandler(
      defineApp({ accounts: {} }, async (context) => ({
        mutations: {
          ask: mutation(
            {
              description: "Ask",
              input: object({}),
              // Both forms deliberately close over the evaluation context, like ordinary app code.
            },
            mode === "promise"
              ? async () => context.elicit(form)
              : toPromise(() => fromPromise(context.elicit)(form)),
          ),
        },
      })),
    );
    const pending = handler(
      new Request("https://app.internal/dispatch", {
        method: "POST",
        body: JSON.stringify({ operation: "call", tool: "mutations.ask", input: {} }),
      }),
      {
        ...hostContext({}),
        elicitation: () =>
          Effect.gen(function* () {
            assert.equal(
              (yield* Effect.currentSpan.pipe(Effect.orDie)).name,
              "app.tool.elicitation",
            );
            yield* Deferred.succeed(entered, undefined);
            return yield* Deferred.await(answer);
          }),
      },
    ).then((response) => {
      finished = true;
      return response;
    });
    await Effect.runPromise(Deferred.await(entered));
    assert.equal(finished, false, "The tool still waits for its actual input response");
    await Effect.runPromise(
      Deferred.succeed(answer, { action: "accept", content: { name: "synthetic-private-answer" } }),
    );
    const response = await pending;
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        ok: Schema.Literal(true),
        value: Schema.Json,
        telemetry: TelemetryBatch,
      }),
    )(await response.json());
    const Export = Schema.fromJsonString(
      Schema.Struct({
        resourceSpans: Schema.Array(
          Schema.Struct({
            scopeSpans: Schema.Array(
              Schema.Struct({
                spans: Schema.Array(
                  Schema.Struct({
                    name: Schema.String,
                    traceId: Schema.String,
                    spanId: Schema.String,
                    parentSpanId: Schema.optional(Schema.String),
                    startTimeUnixNano: Schema.String,
                    endTimeUnixNano: Schema.String,
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    );
    const spans = body.telemetry.traces.flatMap((batch) =>
      Schema.decodeUnknownSync(Export)(batch).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const execute = spans.find((span) => span.name === "app.operation.execute");
    const wait = spans.find((span) => span.name === "app.tool.elicitation");
    assert.ok(execute && wait);
    assert.equal(wait.traceId, execute.traceId);
    assert.equal(wait.parentSpanId, execute.spanId);
    assert.ok(BigInt(wait.startTimeUnixNano) >= BigInt(execute.startTimeUnixNano));
    assert.ok(BigInt(wait.endTimeUnixNano) <= BigInt(execute.endTimeUnixNano));
    assert.deepEqual(body.value, {
      action: "accept",
      content: { name: "synthetic-private-answer" },
    });
    assert.doesNotMatch(body.telemetry.traces.join(""), /synthetic-private-answer/);
  });
}
