/**
 * Local-only probe of what a tool call says when its exchange with the app runtime never formed,
 * through the SDK's own call path: `executor.tools.call` and `executor.tools.resume`, the real
 * `appRuntime` (which marks each hand-off to the app's code), PGlite in memory, and a stub in
 * place of the runtime's transport only. The stub answers the catalog read for a call's kind,
 * asks approval for a call when told to, and fails a call the way the transport does when its
 * socket never opened twice (`RuntimeProtocolFailed`, `notSent`). Prints, as JSON, what the caller
 * received, for `runtime-connect-repeat.spec.ts` to judge.
 *
 * - `call-once`: the call names its kind, so the call is its only hand-off.
 * - `call-after-kind-read`: the call names no kind, so the catalog read for its kind comes first.
 * - `call-resumed`: the call asks approval; the resumed call is its second hand-off.
 */
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { pgliteLayer } from "fumadb-effect/pglite";
import { SqlClient } from "effect/sql";
import { approvalElicitation } from "apps/contracts";
import { BuiltApp, RuntimeProtocolFailed } from "../src/contracts/runtime.ts";
import { CurrentActor, createExecutor, makeExecutorStorage, runtimeAdapter } from "../src/core.ts";
import { appRuntime } from "../src/implementation/app-runtime.ts";
import { memoryBlobStore } from "../src/implementation/memory-blobs.ts";
import { markdownRefusals } from "../src/markdown.ts";
import { memoryRegistry, memoryRepositories } from "../src/testing.ts";

const cases = ["call-once", "call-after-kind-read", "call-resumed"] as const;
type Case = (typeof cases)[number];
const name = process.argv[process.argv.indexOf("--case") + 1] as Case;
if (!cases.includes(name)) throw new Error(`--case must be one of ${cases.join(", ")}`);

/** What the stub transport was asked for, in order. */
const operations: string[] = [];
let calls = 0;

/** The transport the real `appRuntime` sends each invocation through. */
const transport = {
  name: "runtime.stub",
  loadBuild: () => Effect.die(new Error("The stub runtime keeps no builds")),
  build: () =>
    Schema.decodeUnknownEffect(BuiltApp)({
      build: "bld_00000000-0000-4000-8000-000000000001",
      requirements: { accounts: { app: {}, user: {} } },
    }),
  asset: () => Effect.succeed(undefined),
  changes: () => Stream.empty,
  invoke: (invocation: { readonly command: { readonly operation: string } }) => {
    operations.push(invocation.command.operation);
    switch (invocation.command.operation) {
      case "inspect":
        // The tool declares no read-only kind: a mutation.
        return Effect.succeed({
          ok: true,
          value: {
            tools: [{ name: "probe", description: "Probe", inputSchema: { type: "object" } }],
            routers: [],
          },
        });
      case "call":
        calls += 1;
        // Asked approval first when the case says so; after that, never connected.
        return name === "call-resumed" && calls === 1
          ? Effect.succeed({
              ok: false,
              error: {
                _tag: "HostToolApprovalRequired",
                input: {},
                elicitation: approvalElicitation("probe", {}),
              },
            })
          : Effect.fail(new RuntimeProtocolFailed({ reason: "disconnected", notSent: true }));
      default:
        return Effect.die(
          new Error(`The stub runtime does not run ${invocation.command.operation}`),
        );
    }
  },
};

const failureOf = (exit: unknown) => {
  const reasons = (exit as { cause?: { reasons?: Array<{ error?: Record<string, unknown> }> } })
    .cause?.reasons;
  const error = reasons?.[0]?.error;
  return error === undefined
    ? undefined
    : {
        tag: error._tag,
        reason: error.reason,
        notSent: error.notSent === true,
        mayHaveWritten: error.mayHaveWritten === true,
      };
};

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  yield* storage.migrate;
  const runtime = yield* appRuntime(transport as never);
  const executor = yield* createExecutor({
    database: storage,
    secret: Redacted.make("0".repeat(64)),
    git: memoryRepositories(),
    markdown: markdownRefusals,
    blobs: memoryBlobStore(),
    runtime: runtimeAdapter(runtime as never),
    registry: memoryRegistry(),
  } as never);
  const { app } = yield* executor.apps.deploy({
    owner: "local",
    name: "Probe",
    files: [
      { path: "index.ts", content: "export default {}" },
      {
        path: "package.json",
        content: JSON.stringify({ type: "module", dependencies: { apps: "0.0.1" } }),
      },
    ],
  } as never);
  const call = (kind?: "mutation") =>
    executor.tools.call({
      app: app.id,
      tool: "probe",
      input: {},
      ...(kind === undefined ? {} : { kind }),
    } as never);
  if (name === "call-resumed") {
    const asked = (yield* call("mutation")) as { status?: string; requestId?: string };
    const resumed = yield* Effect.exit(
      executor.tools.resume({
        requestId: asked.requestId,
        response: { action: "accept" },
      } as never),
    );
    // A resume answers with its outcome; a failed one carries the call's error.
    const answered =
      resumed._tag === "Success" ? (resumed.value as { error?: unknown }) : undefined;
    return {
      asked: asked.status,
      failure:
        answered?.error === undefined
          ? failureOf(resumed)
          : failureOf({ cause: { reasons: [{ error: answered.error }] } }),
      resumed: resumed._tag === "Success" ? JSON.stringify(resumed.value).slice(0, 400) : undefined,
      operations,
    };
  }
  const exit = yield* Effect.exit(call(name === "call-once" ? "mutation" : undefined));
  return { failure: failureOf(exit), operations };
}).pipe(Effect.provideService(CurrentActor, "local" as never));

Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.provide(
      Layer.mergeAll(pgliteLayer({}), NodeCrypto.layerSecureRandom, NodeCrypto.layerDigest),
    ),
    Effect.timeout("60 seconds"),
  ) as never,
).then(
  (result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  },
  (error) => {
    console.error(String(error).slice(0, 2000));
    process.exit(1);
  },
);
